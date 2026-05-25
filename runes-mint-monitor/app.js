/* Runes Mint Monitor
 * - mempool.space  : 实时 fee + tip
 * - ordinals.com   : rune metadata (terms / mints / cap)
 * - localStorage   : 关注列表
 *
 * 注意:Bound 的 launchpad 列表没有公开 API,匿名拉不到 "preparing to launch" 的清单。
 * 所以本工具的玩法是:在 Bound launchpad 看到一个准备发射的符文,
 * 把链接 / 名字 / ID 粘到这,这里替你算下一块的 mint gas。
 */

(function () {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    tipHeight: $("tipHeight"),
    tipAge: $("tipAge"),
    nextBlockMin: $("nextBlockMin"),
    nextBlockMedian: $("nextBlockMedian"),
    mempoolPending: $("mempoolPending"),
    mempoolBlocks: $("mempoolBlocks"),
    wsStatus: $("wsStatus"),
    wsLabel: $("wsLabel"),

    runeInput: $("runeInput"),
    repeats: $("repeats"),
    vbytes: $("vbytes"),
    btcUsd: $("btcUsd"),
    lookupBtn: $("lookupBtn"),
    watchBtn: $("watchBtn"),
    openBoundBtn: $("openBoundBtn"),
    openMempoolBtn: $("openMempoolBtn"),

    runeResult: $("runeResult"),
    resName: $("resName"),
    resId: $("resId"),
    resStatus: $("resStatus"),
    mAmount: $("mAmount"),
    mProgress: $("mProgress"),
    mBar: $("mBar"),
    mRemaining: $("mRemaining"),
    mHeights: $("mHeights"),
    mNextFee: $("mNextFee"),
    mNextFeeHint: $("mNextFeeHint"),
    mTotalFee: $("mTotalFee"),
    mTotalFeeUsd: $("mTotalFeeUsd"),
    rawJson: $("rawJson"),

    watchBody: $("watchBody"),

    latLast: $("latLast"),
    latAvg: $("latAvg"),
  };

  // ---------- State ----------
  const state = {
    tip: { height: null, timestamp: null },
    fees: { recommended: null, mempoolBlocks: null },
    currentRune: null,         // last looked-up rune
    blockLatencies: [],         // last few "ws block detect" delays in seconds
  };

  const STORAGE_KEY = "runes-mint-monitor:watch";
  const PRICE_KEY = "runes-mint-monitor:btcusd";

  // ---------- Utils ----------
  function fmtNum(n, dp = 0) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    return Number(n).toLocaleString("en-US", {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  }
  function fmtBTC(sats) {
    if (sats === null || sats === undefined || Number.isNaN(sats)) return "—";
    return (sats / 1e8).toFixed(8) + " BTC";
  }
  function fmtAge(tsSec) {
    if (!tsSec) return "—";
    const sec = Math.max(0, Math.floor(Date.now() / 1000 - tsSec));
    if (sec < 60) return sec + "s ago";
    if (sec < 3600) return Math.floor(sec / 60) + "m " + (sec % 60) + "s ago";
    return Math.floor(sec / 3600) + "h ago";
  }
  function setStatus(stateName, text) {
    els.wsStatus.dataset.state = stateName;
    els.wsLabel.textContent = text;
  }

  // Apply BTC/USD persisted value
  const cachedPrice = Number(localStorage.getItem(PRICE_KEY) || 0);
  if (cachedPrice > 0) els.btcUsd.value = cachedPrice;
  els.btcUsd.addEventListener("change", () => {
    localStorage.setItem(PRICE_KEY, String(Number(els.btcUsd.value) || 0));
    if (state.currentRune) renderRune(state.currentRune);
    renderWatchTable();
  });

  // ---------- Mempool.space fees + tip (REST + WS) ----------
  async function fetchRecommended() {
    try {
      const r = await fetch("https://mempool.space/api/v1/fees/recommended", { cache: "no-store" });
      state.fees.recommended = await r.json();
    } catch (e) {
      console.warn("recommended fees fetch failed", e);
    }
  }
  async function fetchMempoolBlocks() {
    try {
      const r = await fetch("https://mempool.space/api/v1/fees/mempool-blocks", { cache: "no-store" });
      const arr = await r.json();
      state.fees.mempoolBlocks = arr;
    } catch (e) {
      console.warn("mempool-blocks fetch failed", e);
    }
  }
  async function fetchTip() {
    try {
      const [hRes, blocksRes] = await Promise.all([
        fetch("https://mempool.space/api/blocks/tip/height", { cache: "no-store" }),
        fetch("https://mempool.space/api/v1/blocks/0", { cache: "no-store" }),
      ]);
      const h = Number(await hRes.text());
      const blocks = await blocksRes.json();
      state.tip.height = h;
      if (Array.isArray(blocks) && blocks.length) {
        const matching = blocks.find((b) => b && b.height === h);
        state.tip.timestamp = matching ? matching.timestamp : blocks[0].timestamp || null;
      }
    } catch (e) {
      console.warn("tip fetch failed", e);
    }
  }

  function renderTopStats() {
    if (state.tip.height) els.tipHeight.textContent = "#" + fmtNum(state.tip.height);
    if (state.tip.timestamp) els.tipAge.textContent = fmtAge(state.tip.timestamp);
    if (state.fees.recommended) {
      // mempool.space "recommended" is keyed differently; "fastestFee" is "next-block".
      const f = state.fees.recommended;
      els.nextBlockMin.textContent = `${fmtNum(f.fastestFee)} sat/vB`;
    }
    if (state.fees.mempoolBlocks && state.fees.mempoolBlocks.length) {
      const next = state.fees.mempoolBlocks[0];
      const minFee = Math.min(...next.feeRange);
      const med = next.medianFee;
      els.nextBlockMin.textContent = `${minFee.toFixed(2)} sat/vB`;
      els.nextBlockMedian.textContent = `中位数 ${med.toFixed(2)} sat/vB · ${next.nTx} TXs`;
      const totalTx = state.fees.mempoolBlocks.reduce((a, b) => a + b.nTx, 0);
      els.mempoolPending.textContent = fmtNum(totalTx) + " TX";
      els.mempoolBlocks.textContent = state.fees.mempoolBlocks.length + " 个待打包块";
    }
  }

  function bestNextBlockFee() {
    // Returns sat/vB you should pay to make next block, plus reasoning.
    if (state.fees.mempoolBlocks && state.fees.mempoolBlocks.length) {
      const next = state.fees.mempoolBlocks[0];
      const minFee = Math.min(...next.feeRange); // last guaranteed inclusion sat/vB
      const med = next.medianFee;
      // Suggest median (safe) and minimum (aggressive)
      return { min: minFee, suggested: med, source: "mempool-blocks[0]" };
    }
    if (state.fees.recommended) {
      return {
        min: state.fees.recommended.fastestFee,
        suggested: state.fees.recommended.fastestFee,
        source: "fees/recommended.fastestFee",
      };
    }
    return null;
  }

  // ws to refresh on every new block + tx replacement
  let ws = null;
  let wsLastPing = null;
  let lastBlockReceivedAt = null;
  function startWS() {
    setStatus("connecting", "连接中…");
    try {
      ws = new WebSocket("wss://mempool.space/api/v1/ws");
    } catch (e) {
      setStatus("closed", "无法连接");
      return;
    }
    ws.onopen = () => {
      setStatus("open", "已连接");
      ws.send(JSON.stringify({ action: "want", data: ["blocks", "stats", "mempool-blocks"] }));
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.block) {
          const b = msg.block;
          state.tip.height = b.height;
          state.tip.timestamp = b.timestamp;
          // Latency: now - block timestamp = how stale BTC -> we receive
          const detectAt = Date.now() / 1000;
          const lat = detectAt - b.timestamp;
          state.blockLatencies.unshift(lat);
          state.blockLatencies = state.blockLatencies.slice(0, 5);
          els.latLast.textContent = `#${b.height} · ${lat.toFixed(1)}s 后探测到`;
          const avg = state.blockLatencies.reduce((a, c) => a + c, 0) / state.blockLatencies.length;
          els.latAvg.textContent = `${avg.toFixed(1)}s (n=${state.blockLatencies.length})`;
          // After a new block, refresh fees + watched runes
          fetchMempoolBlocks().then(() => {
            renderTopStats();
            if (state.currentRune) refreshRune(state.currentRune.id || state.currentRune.entry.spaced_rune.replace(/•/g, ""));
            refreshWatchAll();
          });
          renderTopStats();
        }
        if (msg["mempool-blocks"]) {
          state.fees.mempoolBlocks = msg["mempool-blocks"];
          renderTopStats();
          if (state.currentRune) renderRune(state.currentRune);
          renderWatchTable();
        }
      } catch (e) {
        // ignore
      }
    };
    ws.onclose = () => {
      setStatus("closed", "已断开,2s 后重连");
      setTimeout(startWS, 2000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch (e) {}
    };
  }

  // ---------- Rune lookup (ordinals.com) ----------
  function normalizeRuneInput(raw) {
    let s = (raw || "").trim();
    if (!s) return null;
    // Bound URL: https://app.bound.exchange/launchpad/<runeId>
    const boundMatch = s.match(/launchpad\/([^/?#]+)/i);
    if (boundMatch) s = decodeURIComponent(boundMatch[1]);
    // mempool.space rune URL? doesn't really exist, but support /rune/...
    const ordMatch = s.match(/\/rune\/([^/?#]+)/i);
    if (ordMatch) s = decodeURIComponent(ordMatch[1]);
    // strip spacers - ordinals.com expects unspaced names for the lookup
    s = s.replace(/\s+/g, "");
    return s;
  }

  async function lookupRune(rawInput) {
    const id = normalizeRuneInput(rawInput);
    if (!id) throw new Error("空的输入");
    // Try ordinals.com /rune/{id}
    const url = "https://ordinals.com/rune/" + encodeURIComponent(id);
    const r = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!r.ok) throw new Error(`ordinals.com 返回 ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    const text = await r.text();
    if (!ct.includes("json")) throw new Error("ordinals.com JSON API 暂时不可用,稍后重试 (HTTP " + r.status + ")");
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("非 JSON 响应:" + text.slice(0, 60)); }
    return data;
  }

  function classifyRune(d) {
    // returns {state: 'pre'|'live'|'ended'|'closed', text}
    const e = d.entry || {};
    const terms = e.terms || null;
    const tip = state.tip.height || 0;
    if (!terms) return { state: "closed", text: "无 mint terms (premine-only)" };
    const cap = terms.cap;
    const used = e.mints || 0;
    if (cap && used >= cap) return { state: "ended", text: "已 mint 满" };
    const hStart = (terms.height && terms.height[0]) || null;
    const hEnd = (terms.height && terms.height[1]) || null;
    if (hStart && tip < hStart) return { state: "pre", text: `等待开放 (距开放还有 ${hStart - tip} 块)` };
    if (hEnd && tip > hEnd) return { state: "ended", text: "高度窗口已关闭" };
    if (d.mintable === false) return { state: "closed", text: "当前不可 mint" };
    return { state: "live", text: "正在 mint" };
  }

  function computeFeeForRune() {
    const f = bestNextBlockFee();
    if (!f) return null;
    const vbytes = Math.max(50, Number(els.vbytes.value) || 160);
    const repeats = Math.max(1, Number(els.repeats.value) || 1);
    const totalSatsMin = Math.ceil(f.min * vbytes * repeats);
    const totalSatsSug = Math.ceil(f.suggested * vbytes * repeats);
    const usd = Number(els.btcUsd.value) || 0;
    return {
      fee: f,
      vbytes, repeats,
      totalSatsMin, totalSatsSug,
      totalUsdMin: usd ? totalSatsMin / 1e8 * usd : null,
      totalUsdSug: usd ? totalSatsSug / 1e8 * usd : null,
    };
  }

  function renderRune(d) {
    state.currentRune = d;
    const e = d.entry || {};
    els.runeResult.classList.remove("hidden");
    els.resName.textContent = e.spaced_rune || "—";
    const idStr = d.id || (e.block ? `${e.block}:${e.number ?? "?"}` : "—");
    els.resId.textContent = `${idStr} · 起始于 #${e.block}`;

    const cls = classifyRune(d);
    els.resStatus.className = "status " + cls.state;
    els.resStatus.textContent = cls.text;

    const div = e.divisibility || 0;
    const terms = e.terms || {};
    const amount = terms.amount;
    const cap = terms.cap;
    const used = e.mints || 0;
    const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
    const remaining = cap ? Math.max(0, cap - used) : null;

    const dispAmount = amount !== undefined ? formatRuneNum(amount, div) : "—";
    els.mAmount.textContent = dispAmount + (e.symbol ? " " + e.symbol : "");

    if (cap !== undefined) {
      els.mProgress.textContent = `${fmtNum(used)} / ${fmtNum(cap)} (${pct.toFixed(2)}%)`;
      els.mBar.style.width = pct + "%";
    } else {
      els.mProgress.textContent = "—";
      els.mBar.style.width = "0%";
    }
    els.mRemaining.textContent = remaining !== null ? fmtNum(remaining) : "—";

    const hs = (terms.height && terms.height[0]) ?? "—";
    const he = (terms.height && terms.height[1]) ?? "—";
    els.mHeights.textContent = `${hs} → ${he}`;

    // Fee
    const calc = computeFeeForRune();
    if (calc) {
      els.mNextFee.textContent =
        `${calc.fee.min.toFixed(2)} (min) / ${calc.fee.suggested.toFixed(2)} sat/vB (建议)`;
      els.mNextFeeHint.textContent = `源:${calc.fee.source} · 单笔 ${calc.vbytes} vB × ${calc.repeats} 次`;
      els.mTotalFee.textContent = `${fmtNum(calc.totalSatsSug)} sats (${fmtBTC(calc.totalSatsSug)})`;
      els.mTotalFeeUsd.textContent = calc.totalUsdSug !== null
        ? `≈ $${fmtNum(calc.totalUsdSug, 2)} (建议档) · 最低 $${fmtNum(calc.totalUsdMin, 2)}`
        : `最低 ${fmtNum(calc.totalSatsMin)} sats · 输入 BTC/USD 看美元价`;
    } else {
      els.mNextFee.textContent = "等 fee 数据…";
      els.mTotalFee.textContent = "—";
      els.mTotalFeeUsd.textContent = "—";
    }

    els.rawJson.textContent = JSON.stringify(d, null, 2);
  }

  function formatRuneNum(amount, divisibility) {
    if (amount === undefined || amount === null) return "—";
    if (!divisibility) return fmtNum(Number(amount));
    const a = String(amount);
    if (a.length <= divisibility) {
      return "0." + a.padStart(divisibility, "0").replace(/0+$/, "") || "0";
    }
    const intp = a.slice(0, a.length - divisibility);
    const fracp = a.slice(a.length - divisibility).replace(/0+$/, "");
    return fracp ? `${fmtNum(Number(intp))}.${fracp}` : fmtNum(Number(intp));
  }

  async function refreshRune(rawInput) {
    try {
      const d = await lookupRune(rawInput);
      renderRune(d);
    } catch (e) {
      console.warn("rune lookup failed", e);
      els.runeResult.classList.remove("hidden");
      els.resName.textContent = "查询失败";
      els.resId.textContent = "";
      els.resStatus.className = "status bad";
      els.resStatus.textContent = e.message || String(e);
      // Suggest manual fallback
      els.mAmount.textContent = "—";
      els.mProgress.textContent = "—";
      els.mRemaining.textContent = "—";
      els.mHeights.textContent = "—";
      const calc = computeFeeForRune();
      if (calc) {
        els.mNextFee.textContent = `${calc.fee.min.toFixed(2)} / ${calc.fee.suggested.toFixed(2)} sat/vB`;
        els.mNextFeeHint.textContent = `${calc.fee.source} · ${calc.vbytes} vB × ${calc.repeats}`;
        els.mTotalFee.textContent = `${fmtNum(calc.totalSatsSug)} sats`;
        els.mTotalFeeUsd.textContent = calc.totalUsdSug !== null ? `≈ $${fmtNum(calc.totalUsdSug, 2)}` : "—";
      }
      els.rawJson.textContent = e.stack || String(e);
    }
  }

  // ---------- Watch list ----------
  function loadWatch() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function saveWatch(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }
  function addToWatch(d) {
    if (!d || !d.entry) return;
    const list = loadWatch();
    const key = d.entry.spaced_rune.replace(/•/g, "") || d.id;
    if (list.find((w) => w.key === key)) return;
    list.push({ key, name: d.entry.spaced_rune, id: d.id, addedAt: Date.now(), data: d });
    saveWatch(list);
    renderWatchTable();
  }
  function removeWatch(key) {
    const list = loadWatch().filter((w) => w.key !== key);
    saveWatch(list);
    renderWatchTable();
  }
  async function refreshWatchAll() {
    const list = loadWatch();
    for (const w of list) {
      try {
        const d = await lookupRune(w.key);
        w.data = d;
      } catch (e) { /* ignore */ }
    }
    saveWatch(list);
    renderWatchTable();
  }

  function renderWatchTable() {
    const list = loadWatch();
    if (!list.length) {
      els.watchBody.innerHTML = `<tr class="empty"><td colspan="6">还没添加。先在上面查一个符文,然后点 "加入关注"。</td></tr>`;
      return;
    }
    const calc = computeFeeForRune();
    const rows = list.map((w) => {
      const d = w.data;
      if (!d || !d.entry) {
        return `<tr><td>${w.name}</td><td>—</td><td>—</td><td>—</td><td>—</td>
          <td class="actions"><button data-act="del" data-key="${w.key}">移除</button></td></tr>`;
      }
      const cls = classifyRune(d);
      const cap = (d.entry.terms && d.entry.terms.cap) || 0;
      const used = d.entry.mints || 0;
      const pct = cap ? ((used / cap) * 100).toFixed(2) : "—";
      const remain = cap ? cap - used : null;
      const feeStr = calc
        ? `${calc.fee.suggested.toFixed(2)} sat/vB · ${fmtNum(calc.totalSatsSug)} sats`
        : "—";
      return `<tr>
        <td><b>${escapeHtml(d.entry.spaced_rune || w.name)}</b><div class="meta">${escapeHtml(d.id || w.key)}</div></td>
        <td><span class="status ${cls.state}">${cls.text}</span></td>
        <td>${cap ? fmtNum(used) + "/" + fmtNum(cap) + " (" + pct + "%)" : "—"}</td>
        <td>${remain !== null ? fmtNum(remain) : "—"}</td>
        <td>${feeStr}</td>
        <td class="actions">
          <button data-act="open" data-key="${escapeAttr(w.key)}">查看</button>
          <button data-act="bound" data-key="${escapeAttr(w.key)}">Bound</button>
          <button data-act="del" data-key="${escapeAttr(w.key)}">移除</button>
        </td>
      </tr>`;
    });
    els.watchBody.innerHTML = rows.join("");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function escapeAttr(s) { return escapeHtml(s); }

  els.watchBody.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const key = btn.dataset.key;
    const act = btn.dataset.act;
    if (act === "del") removeWatch(key);
    if (act === "open") {
      els.runeInput.value = key;
      refreshRune(key);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    if (act === "bound") {
      window.open("https://app.bound.exchange/launchpad/" + encodeURIComponent(key), "_blank");
    }
  });

  // ---------- Buttons ----------
  els.lookupBtn.addEventListener("click", () => refreshRune(els.runeInput.value));
  els.runeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") refreshRune(els.runeInput.value);
  });
  els.repeats.addEventListener("input", () => {
    if (state.currentRune) renderRune(state.currentRune);
    renderWatchTable();
  });
  els.vbytes.addEventListener("input", () => {
    if (state.currentRune) renderRune(state.currentRune);
    renderWatchTable();
  });
  els.watchBtn.addEventListener("click", () => {
    if (state.currentRune) addToWatch(state.currentRune);
  });
  els.openBoundBtn.addEventListener("click", () => {
    const id = normalizeRuneInput(els.runeInput.value);
    if (!id) return;
    window.open("https://app.bound.exchange/launchpad/" + encodeURIComponent(id), "_blank");
  });
  els.openMempoolBtn.addEventListener("click", () => {
    window.open("https://mempool.space/", "_blank");
  });

  // ---------- Boot ----------
  (async function init() {
    await Promise.all([fetchTip(), fetchRecommended(), fetchMempoolBlocks()]);
    renderTopStats();
    setInterval(() => {
      // age tick
      if (state.tip.timestamp) els.tipAge.textContent = fmtAge(state.tip.timestamp);
    }, 5000);
    // periodic resilience refresh in case ws drops
    setInterval(async () => {
      await Promise.all([fetchRecommended(), fetchMempoolBlocks()]);
      renderTopStats();
    }, 60000);
    startWS();
    renderWatchTable();
    refreshWatchAll();
  })();
})();
