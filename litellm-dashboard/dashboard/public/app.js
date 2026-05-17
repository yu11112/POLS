// LiteLLM 用量面板前端
// 依赖同源下的 /api/* 反代到 tracker 服务。
const API_BASE = "/api";
const REFRESH_SEC = 30;
const CHART_DAYS = 30;

const fmtUsd = (n) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const fmtTok = (n) => {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};
const pctClass = (p) => (p == null ? "" : p >= 90 ? "bad" : p >= 70 ? "warn" : "good");

// Chart instances per account
const charts = new Map();

async function getJson(path) {
  const r = await fetch(API_BASE + path, { cache: "no-store" });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

function makeAccountCard(acc) {
  const cls = pctClass(acc.percent_used);
  const budgetTxt = acc.monthly_budget_usd == null ? "未设置预算" : `预算 ${fmtUsd(acc.monthly_budget_usd)}`;
  const pctTxt = acc.percent_used == null ? "—" : acc.percent_used.toFixed(1) + "%";
  const remainTxt = acc.remaining_usd == null ? "—" : fmtUsd(acc.remaining_usd);
  const projTxt = fmtUsd(acc.projected_month_end_usd);
  const width = Math.min(100, acc.percent_used ?? 0);

  return `
    <article class="card" data-aid="${acc.account_id}">
      <div class="bigrow">
        <div>
          <h2>${escapeHtml(acc.label)}</h2>
          <div class="aid">${escapeHtml(acc.account_id)} · <span class="pill ${cls}">${pctTxt}</span></div>
        </div>
        <div style="text-align:right">
          <div class="used">${fmtUsd(acc.used_usd)}</div>
          <div class="budget">${budgetTxt}</div>
        </div>
      </div>

      <div class="bar ${cls}"><span style="width:${width}%"></span></div>
      <div class="bar-legend">
        <span>已用 ${fmtUsd(acc.used_usd)}</span>
        <span>剩余 <b>${remainTxt}</b></span>
      </div>

      <div class="kv">
        <div><div class="k">请求数</div><div class="v">${fmtNum(acc.requests)}</div></div>
        <div><div class="k">总 tokens</div><div class="v">${fmtTok(acc.total_tokens)}</div></div>
        <div><div class="k">Prompt</div><div class="v">${fmtTok(acc.prompt_tokens)}</div></div>
        <div><div class="k">Completion</div><div class="v">${fmtTok(acc.completion_tokens)}</div></div>
      </div>

      <div class="k" style="color:var(--muted);font-size:11px">
        按当前速率预计月末消耗 <b style="color:var(--text)">${projTxt}</b>
      </div>

      <div class="chart-wrap"><canvas id="chart-${cssId(acc.account_id)}"></canvas></div>

      <table class="models" id="models-${cssId(acc.account_id)}">
        <thead><tr><th>模型</th><th class="num">请求</th><th class="num">Tokens</th><th class="num">成本</th></tr></thead>
        <tbody><tr><td colspan="4" style="color:var(--muted)">加载中…</td></tr></tbody>
      </table>
    </article>`;
}

function cssId(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, "_"); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderSummary(s) {
  document.getElementById("s-used").textContent = fmtUsd(s.used_usd);
  document.getElementById("s-used-sub").textContent =
    s.percent_used != null ? `占预算 ${s.percent_used.toFixed(1)}%` : "—";
  document.getElementById("s-budget").textContent = fmtUsd(s.total_budget_usd);
  document.getElementById("s-budget-sub").textContent = "来自 budgets.yaml";
  document.getElementById("s-remaining").textContent = fmtUsd(s.remaining_usd);
  document.getElementById("s-remaining-sub").textContent =
    s.total_budget_usd ? "本月剩余" : "未设置总预算";
  document.getElementById("s-requests").textContent = fmtNum(s.requests);
  document.getElementById("s-tokens").textContent = fmtTok(s.total_tokens) + " tokens";
  if (s.month_start) {
    document.getElementById("month-label").textContent =
      s.month_start.slice(0, 7) + " 月度视图";
  }
}

async function loadDailyChart(aid) {
  const canvas = document.getElementById(`chart-${cssId(aid)}`);
  if (!canvas) return;
  const data = await getJson(`/accounts/${encodeURIComponent(aid)}/daily?days=${CHART_DAYS}`);
  // fill missing days with 0
  const byDay = new Map((data.items || []).map((it) => [it.day, it]));
  const labels = [];
  const costSeries = [];
  const tokSeries = [];
  const today = new Date();
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    labels.push(key.slice(5));
    const row = byDay.get(key);
    costSeries.push(row ? Number(row.cost_usd) || 0 : 0);
    tokSeries.push(row ? Number(row.total_tokens) || 0 : 0);
  }

  let chart = charts.get(aid);
  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = costSeries;
    chart.data.datasets[1].data = tokSeries;
    chart.update();
    return;
  }
  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "USD",
          data: costSeries,
          borderColor: "#4f8cff",
          backgroundColor: "rgba(79,140,255,.15)",
          fill: true,
          tension: 0.3,
          yAxisID: "y",
          pointRadius: 0,
        },
        {
          label: "Tokens",
          data: tokSeries,
          borderColor: "#2ecc71",
          backgroundColor: "rgba(46,204,113,.08)",
          fill: false,
          tension: 0.3,
          yAxisID: "y1",
          pointRadius: 0,
          borderDash: [4, 3],
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#8b97a8", boxWidth: 10 } },
        tooltip: {
          callbacks: {
            label: (ctx) => ctx.dataset.label === "USD"
              ? "USD: " + fmtUsd(ctx.parsed.y)
              : "Tokens: " + fmtTok(ctx.parsed.y),
          },
        },
      },
      scales: {
        x: { ticks: { color: "#8b97a8", maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
             grid: { color: "rgba(255,255,255,.05)" } },
        y: { position: "left", ticks: { color: "#8b97a8", callback: (v) => "$" + v },
             grid: { color: "rgba(255,255,255,.05)" } },
        y1: { position: "right", ticks: { color: "#8b97a8", callback: fmtTok },
              grid: { display: false } },
      },
    },
  });
  charts.set(aid, chart);
}

async function loadModels(aid) {
  const tbody = document.querySelector(`#models-${cssId(aid)} tbody`);
  if (!tbody) return;
  const data = await getJson(`/accounts/${encodeURIComponent(aid)}/models`);
  if (!data.items || !data.items.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--muted)">本月暂无调用</td></tr>`;
    return;
  }
  tbody.innerHTML = data.items
    .map(
      (m) => `<tr>
        <td>${escapeHtml(m.model)}</td>
        <td class="num">${fmtNum(m.requests)}</td>
        <td class="num">${fmtTok(m.total_tokens)}</td>
        <td class="num">${fmtUsd(m.cost_usd)}</td>
      </tr>`
    )
    .join("");
}

async function refresh() {
  try {
    const [summary, accounts] = await Promise.all([
      getJson("/summary"),
      getJson("/accounts"),
    ]);
    renderSummary(summary);

    const container = document.getElementById("accounts");
    if (!accounts.accounts || accounts.accounts.length === 0) {
      container.innerHTML = `<div class="empty">
        还没有任何用量。等待 LiteLLM 第一次回调，或检查 tracker 与 litellm 的网络连通性。
      </div>`;
      return;
    }
    container.innerHTML = accounts.accounts.map(makeAccountCard).join("");

    // 并发加载每个账号的明细
    await Promise.all(
      accounts.accounts.flatMap((a) => [loadDailyChart(a.account_id), loadModels(a.account_id)])
    );
  } catch (e) {
    console.error(e);
    document.getElementById("accounts").innerHTML =
      `<div class="empty">加载失败：${escapeHtml(e.message)}。检查 /api 是否反代到 tracker。</div>`;
  }
}

// 自动刷新
let left = REFRESH_SEC;
setInterval(() => {
  left -= 1;
  if (left <= 0) { left = REFRESH_SEC; refresh(); }
  document.getElementById("countdown").textContent = left;
}, 1000);

document.getElementById("refresh-btn").addEventListener("click", () => {
  left = REFRESH_SEC;
  refresh();
});

refresh();
