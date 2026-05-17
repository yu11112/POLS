"""
LiteLLM custom callback → POST 用量到 Tracker 服务。

在 litellm/config.yaml 里通过：

    litellm_settings:
      callbacks: callback_handler.tracker_callback

引用本文件。模块必须在 PYTHONPATH 里（docker 里挂到 /app）。

参考：
- LiteLLM Custom Callback 约定 log_success_event / async_log_success_event
- kwargs 里能拿到 "litellm_params" -> "model_info" -> "id"（我们在 config 里配的 account_id）
- response_obj.usage / response_obj._hidden_params["response_cost"] 提供 token/cost
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any

import httpx

try:
    from litellm.integrations.custom_logger import CustomLogger
except Exception:  # pragma: no cover - 允许单元测试环境缺失 litellm
    class CustomLogger:  # type: ignore
        pass

log = logging.getLogger("litellm-tracker-cb")

TRACKER_URL = os.environ.get("TRACKER_URL", "http://tracker:8000").rstrip("/")
TRACKER_TIMEOUT = float(os.environ.get("TRACKER_TIMEOUT", "3.0"))

# 复用连接，避免每次调用握手
_client_lock = threading.Lock()
_sync_client: httpx.Client | None = None
_async_client: httpx.AsyncClient | None = None


def _get_sync_client() -> httpx.Client:
    global _sync_client
    with _client_lock:
        if _sync_client is None:
            _sync_client = httpx.Client(timeout=TRACKER_TIMEOUT)
        return _sync_client


def _get_async_client() -> httpx.AsyncClient:
    global _async_client
    with _client_lock:
        if _async_client is None:
            _async_client = httpx.AsyncClient(timeout=TRACKER_TIMEOUT)
        return _async_client


def _extract_payload(kwargs: dict, response_obj: Any) -> dict | None:
    """从 LiteLLM 的 kwargs/response 里提取 tracker /ingest 需要的字段。"""
    try:
        litellm_params = kwargs.get("litellm_params") or {}
        model_info = litellm_params.get("model_info") or {}
        # 我们约定 model_info.id 即 account_id
        account_id = model_info.get("id") or litellm_params.get("metadata", {}).get("account_id")
        if not account_id:
            # 退化为 api_base + 模型，至少能区分
            account_id = litellm_params.get("api_base") or "unknown"

        model = kwargs.get("model") or (response_obj.get("model") if isinstance(response_obj, dict) else getattr(response_obj, "model", "unknown"))

        usage = {}
        hidden = {}
        if isinstance(response_obj, dict):
            usage = response_obj.get("usage") or {}
            hidden = response_obj.get("_hidden_params") or {}
        else:
            usage = getattr(response_obj, "usage", None) or {}
            hidden = getattr(response_obj, "_hidden_params", None) or {}
            # pydantic 模型 usage 可能需要 dict 化
            if hasattr(usage, "model_dump"):
                usage = usage.model_dump()
            elif hasattr(usage, "dict"):
                usage = usage.dict()

        prompt = int(usage.get("prompt_tokens", 0) or 0)
        completion = int(usage.get("completion_tokens", 0) or 0)
        total = int(usage.get("total_tokens", prompt + completion) or 0)

        # LiteLLM 在 hidden_params 下会附带预计算好的成本
        cost = hidden.get("response_cost")
        if cost is None:
            # 兜底：尝试 kwargs["response_cost"]
            cost = kwargs.get("response_cost", 0.0)
        cost = float(cost or 0.0)

        request_id = None
        if isinstance(response_obj, dict):
            request_id = response_obj.get("id")
        else:
            request_id = getattr(response_obj, "id", None)

        return {
            "account_id": str(account_id),
            "model": str(model),
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": total,
            "cost_usd": cost,
            "status": "success",
            "request_id": request_id,
        }
    except Exception as e:  # noqa: BLE001
        log.warning("Failed to build tracker payload: %s", e)
        return None


class TrackerCallback(CustomLogger):
    """把每次 LiteLLM 成功响应的用量推送到 Tracker。"""

    # 同步路径
    def log_success_event(self, kwargs, response_obj, start_time, end_time):  # noqa: D401
        payload = _extract_payload(kwargs, response_obj)
        if not payload:
            return
        try:
            _get_sync_client().post(f"{TRACKER_URL}/ingest", json=payload)
        except Exception as e:  # noqa: BLE001
            log.warning("Tracker ingest failed (sync): %s", e)

    # 异步路径（LiteLLM 默认走这个）
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        payload = _extract_payload(kwargs, response_obj)
        if not payload:
            return
        try:
            await _get_async_client().post(f"{TRACKER_URL}/ingest", json=payload)
        except Exception as e:  # noqa: BLE001
            log.warning("Tracker ingest failed (async): %s", e)


# LiteLLM 通过 "module.attr" 路径来加载回调，必须是可调用或 CustomLogger 实例
tracker_callback = TrackerCallback()
