"""
Tracker: 聚合 LiteLLM 调用用量
-------------------------------
- POST /ingest     LiteLLM callback 写入一条调用记录
- GET  /accounts   所有账号的本月汇总（含预算、余额、进度）
- GET  /accounts/{id}/daily?days=30     按日拆分
- GET  /accounts/{id}/models            按模型拆分
- GET  /summary    所有账号合计
"""
from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DB_PATH = os.environ.get("DB_PATH", "./usage.db")
BUDGETS_PATH = os.environ.get("BUDGETS_PATH", "./budgets.yaml")

_db_lock = threading.Lock()


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------
def init_db() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS calls (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                ts             TEXT    NOT NULL,   -- ISO8601 UTC
                account_id     TEXT    NOT NULL,
                model          TEXT    NOT NULL,
                prompt_tokens  INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens   INTEGER NOT NULL DEFAULT 0,
                cost_usd       REAL    NOT NULL DEFAULT 0,
                status         TEXT    NOT NULL DEFAULT 'success',
                request_id     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_calls_account_ts ON calls(account_id, ts);
            CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);
            """
        )


@contextmanager
def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    try:
        yield conn
    finally:
        conn.close()


def load_budgets() -> dict:
    if not Path(BUDGETS_PATH).exists():
        return {"accounts": {}}
    with open(BUDGETS_PATH, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return {"accounts": data.get("accounts", {}) or {}}


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _month_start_iso(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()


def _days_ago_iso(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class IngestPayload(BaseModel):
    account_id: str = Field(..., description="对应 litellm model_info.id")
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    status: str = "success"
    request_id: Optional[str] = None
    ts: Optional[str] = None  # 可选，默认 now


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="LiteLLM Usage Tracker", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ingest")
def ingest(p: IngestPayload):
    ts = p.ts or _now_iso()
    with _db_lock, _connect() as conn:
        conn.execute(
            """INSERT INTO calls
               (ts, account_id, model, prompt_tokens, completion_tokens,
                total_tokens, cost_usd, status, request_id)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                ts,
                p.account_id,
                p.model,
                p.prompt_tokens,
                p.completion_tokens,
                p.total_tokens,
                p.cost_usd,
                p.status,
                p.request_id,
            ),
        )
    return {"ok": True}


def _aggregate_since(since_iso: str, account_id: Optional[str] = None) -> dict:
    q = """SELECT
             COALESCE(SUM(cost_usd),0)          AS cost_usd,
             COALESCE(SUM(total_tokens),0)      AS total_tokens,
             COALESCE(SUM(prompt_tokens),0)     AS prompt_tokens,
             COALESCE(SUM(completion_tokens),0) AS completion_tokens,
             COUNT(*)                           AS requests
           FROM calls
           WHERE ts >= ? AND status = 'success'"""
    args: list = [since_iso]
    if account_id:
        q += " AND account_id = ?"
        args.append(account_id)
    with _connect() as conn:
        row = conn.execute(q, args).fetchone()
    return dict(row) if row else {}


@app.get("/accounts")
def list_accounts():
    """返回所有账号的本月用量 + 预算 + 余额。账号并集 = 预算配置 ∪ DB 实际出现过的。"""
    budgets = load_budgets()["accounts"]
    month_start = _month_start_iso()

    with _connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT account_id FROM calls WHERE ts >= ?",
            (month_start,),
        ).fetchall()
    seen_ids = {r["account_id"] for r in rows}
    all_ids = sorted(set(budgets.keys()) | seen_ids)

    now = datetime.now(timezone.utc)
    # 当月天数 / 已过去天数，用于"按当前速率预测是否超支"
    month_end = (now.replace(day=28) + timedelta(days=4)).replace(day=1)
    days_in_month = (month_end - now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)).days
    elapsed_days = max(1, (now - now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)).days + 1)

    out = []
    for aid in all_ids:
        agg = _aggregate_since(month_start, aid)
        meta = budgets.get(aid, {})
        budget = float(meta.get("monthly_budget_usd", 0) or 0)
        used = float(agg.get("cost_usd", 0) or 0)
        remaining = max(0.0, budget - used) if budget > 0 else None
        pct = (used / budget * 100.0) if budget > 0 else None
        projected = used / elapsed_days * days_in_month if elapsed_days > 0 else used
        out.append(
            {
                "account_id": aid,
                "label": meta.get("label", aid),
                "monthly_budget_usd": budget if budget > 0 else None,
                "used_usd": round(used, 4),
                "remaining_usd": round(remaining, 4) if remaining is not None else None,
                "percent_used": round(pct, 2) if pct is not None else None,
                "projected_month_end_usd": round(projected, 4),
                "requests": agg.get("requests", 0),
                "total_tokens": agg.get("total_tokens", 0),
                "prompt_tokens": agg.get("prompt_tokens", 0),
                "completion_tokens": agg.get("completion_tokens", 0),
            }
        )
    return {"month_start": month_start, "accounts": out}


@app.get("/summary")
def summary():
    month_start = _month_start_iso()
    agg = _aggregate_since(month_start)
    budgets = load_budgets()["accounts"]
    total_budget = sum(float(v.get("monthly_budget_usd", 0) or 0) for v in budgets.values())
    used = float(agg.get("cost_usd", 0) or 0)
    return {
        "month_start": month_start,
        "used_usd": round(used, 4),
        "total_budget_usd": total_budget if total_budget > 0 else None,
        "remaining_usd": round(max(0.0, total_budget - used), 4) if total_budget > 0 else None,
        "percent_used": round(used / total_budget * 100, 2) if total_budget > 0 else None,
        "requests": agg.get("requests", 0),
        "total_tokens": agg.get("total_tokens", 0),
    }


@app.get("/accounts/{account_id}/daily")
def daily(account_id: str, days: int = 30):
    if days < 1 or days > 365:
        raise HTTPException(400, "days must be 1..365")
    since = _days_ago_iso(days)
    with _connect() as conn:
        rows = conn.execute(
            """SELECT substr(ts,1,10) AS day,
                      SUM(cost_usd)    AS cost_usd,
                      SUM(total_tokens) AS total_tokens,
                      COUNT(*)         AS requests
               FROM calls
               WHERE account_id = ? AND ts >= ? AND status = 'success'
               GROUP BY day ORDER BY day""",
            (account_id, since),
        ).fetchall()
    return {"account_id": account_id, "days": days, "items": [dict(r) for r in rows]}


@app.get("/accounts/{account_id}/models")
def by_model(account_id: str):
    month_start = _month_start_iso()
    with _connect() as conn:
        rows = conn.execute(
            """SELECT model,
                      SUM(cost_usd)     AS cost_usd,
                      SUM(total_tokens) AS total_tokens,
                      COUNT(*)          AS requests
               FROM calls
               WHERE account_id = ? AND ts >= ? AND status = 'success'
               GROUP BY model ORDER BY cost_usd DESC""",
            (account_id, month_start),
        ).fetchall()
    return {"account_id": account_id, "items": [dict(r) for r in rows]}
