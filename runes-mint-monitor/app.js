/* Runes Mint Monitor
 *
 * Data sources (all verified to work without API key, with CORS):
 *   - Block tip + fees (REST + WS): mempool.space
 *   - Rune metadata: api.xverse.app/v1/runes/{NAME|RUNE_ID}
 *     (Xverse runs an `ord` HTTP server with CORS. Schema is identical to the
 *      classic ordinals.com /rune/<name>.json that ordinals.com retired.)
 *
 * The page never sends or signs transactions. It just reads.
 */

(function () {
  "use strict";

  // ---------- Config ----------
  // Primary + fallback rune metadata endpoints. Each must accept GET and return
  // the ord-style { entry: { ... }, id, mintable, parent } shape.
  const RUNE_API_PRIMARY = "https://api.xverse.app/v1/runes/";
  // Public ord HTTP servers historically expose the same shape at /rune/<name>.
  // We keep ordinals.com as a *secondary* probe in case they re-enable JSON later.
  const RUNE_API_FALLBACK = "https://ordinals.com/rune/";

  const MEMPOOL_API = "https://mempool.space/api";
  const MEMPOOL_WS = "wss://mempool.space/api/v1/ws";

  // u64::MAX (Runes "no cap" sentinel) and u128::MAX (Runes max cap field).
  // Anything close to either is rendered as "无上限" rather than a giant number.
  const HUGE_NUMBER_THRESHOLD = 1e15; // beyond this we lose Number precision

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
    latApiSource: $("latApiSource"),
  };

  // ---------- State ----------
  const state = {
    tip: { height: null, timestamp: null },
    fees: { recommended: null, mempoolBlocks: null },
    currentRune: null,         // last looked-up rune
    blockLatencies: [],         // last few "ws block detect" delays in seconds
    activeRuneSource: null,     // which API succeeded last time
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

  /** Return true if we should treat this number as "effectively unlimited"
   *  (Runes spec uses u128 for cap; many runes set it to u64::MAX or u128::MAX). */
  function isHuge(n) {
    if (n === null || n === undefined) return false;
    return Number(n) >= HUGE_NUMBER_THRESHOLD;
  }

  /** Safe percentage that doesn't blow up if cap is a 1e38 sentinel. */
  function safePercent(used, cap) {
    if (!cap || isHuge(cap)) return null;
    const u = Number(used) || 0;
    const c = Number(cap);
    if (c <= 0) return null;
    return Math.max(0, Math.min(100, (u / c) * 100));
  }

  /** Re-format a Runes raw amount (which is a u128 with `divisibility` decimal
   *  places) into a human-readable string. The original code had two bugs:
   *    1. `"0." + s.replace(/0+$/, "") || "0"` — string concat is always
   *       truthy, so the "|| 0" branch never fires; "1" with div=8 produced "0."
   *    2. didn't handle the case where the trimmed fractional part is empty.
   *  We use BigInt for the integer part to preserve precision. */
  function formatRuneNum(amount, divisibility) {
    if (amount === undefined || amount === null) return "—";
    if (!divisibility) {
      // No decimals; render as plain integer with grouping, falling back to
      // raw string if the number exceeds Number.MAX_SAFE_INTEGER.
      const n = Number(amount);
      if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) return String(amount);
      return fmtNum(n);
    }
    const a = String(amount);
    if (a === "0") return "0";
    if (a.length <= divisibility) {
      // Pure-fractional value, e.g. amount=1, divisibility=8 → "0.00000001"
      const padded = a.padStart(divisibility, "0").replace(/0+$/, "");
      return padded ? "0." + padded : "0";
    }
    const intPart = a.slice(0, a.length - divisibility);
    const fracPart = a.slice(a.length - divisibility).replace(/0+$/, "");
    let intDisplay;
    try {
      const big = BigInt(intPart);
      intDisplay = big > BigInt(Number.MAX_SAFE_INTEGER)
        ? intPart  // too big for grouping, show raw
        : fmtNum(Number(big));
    } catch (e) {
      intDisplay = intPart;
    }
    return fracPart ? `${intDisplay}.${fracPart}` : intDisplay;
  }

  /** Subtract used from cap with BigInt for precision. Returns Number, or null
   *  if cap is "huge" (treat as unlimited). */
  function safeRemaining(used, cap) {
    if (!cap || isHuge(cap)) return null;
    try {
      const big = BigInt(cap) - BigInt(used || 0);
      if (big < 0n) return 0;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return Number(big);
      return Number(big);
    } catch (e) {
      const n = Number(cap) - Number(used || 0);
      return n > 0 ? n : 0;
    }
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
      const r = await fetch(MEMPOOL_API + "/v1/fees/recommended", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      state.fees.recommended = await r.json();
    } catch (e) {
      console.warn("recommended fees fetch failed", e);
    }
  }
  async function fetchMempoolBlocks() {
    try {
      const r = await fetch(MEMPOOL_API + "/v1/fees/mempool-blocks", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const arr = await r.json();
      if (Array.isArray(arr)) state.fees.mempoolBlocks = arr;
    } catch (e) {
      console.warn("mempool-blocks fetch failed", e);
    }
  }
  async function fetchTip() {
    // /api/blocks/tip returns an array with the latest few blocks (height +
    // timestamp). Far more reliable than /api/v1/blocks/0 (which currently 502s).
    try {
      const r = await fetch(MEMPOOL_API + "/blocks/tip", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      const tip = Array.isArray(data) ? data[0] : data;
      if (tip && typeof tip.height === "number") {
        state.tip.height = tip.height;
        state.tip.timestamp = tip.timestamp || null;
      }
    } catch (e) {
      console.warn("tip fetch failed", e);
      // Backstop: at least grab the height even if metadata fetch fails.
      try {
        const r2 = await fetch(MEMPOOL_API + "/blocks/tip/height", { cache: "no-store" });
        if (r2.ok) state.tip.height = Number(await r2.text());
      } catch (e2) { /* ignore */ }
    }
  }

  function renderTopStats() {
    if (state.tip.height) els.tipHeight.textContent = "#" + fmtNum(state.tip.height);
    if (state.tip.timestamp) els.tipAge.textContent = fmtAge(state.tip.timestamp);
    if (state.fees.recommended) {
      const f = state.fees.recommended;
      els.nextBlockMin.textContent = `${fmtNum(f.fastestFee)} sat/vB`;
    }
    if (state.fees.mempoolBlocks && state.fees.mempoolBlocks.length) {
      const next = state.fees.mempoolBlocks[0];
      // mempool.space returns feeRange sorted ascending; [0] is the lowest
      // sat/vB that still made it into the projected next block template.
      const minFee = next.feeRange && next.feeRange.length ? Math.min(...next.feeRange) : null;
      const med = next.medianFee;
      if (minFee !== null) els.nextBlockMin.textContent = `${minFee.toFixed(2)} sat/vB`;
      if (med != null) {
        els.nextBlockMedian.textContent = `中位数 ${med.toFixed(2)} sat/vB · ${fmtNum(next.nTx)} TXs`;
      }
      const totalTx = state.fees.mempoolBlocks.reduce((a, b) => a + (b.nTx || 0), 0);
      els.mempoolPending.textContent = fmtNum(totalTx) + " TX";
      els.mempoolBlocks.textContent = state.fees.mempoolBlocks.length + " 个待打包块";
    }
  }

  function bestNextBlockFee() {
    // Returns sat/vB you should pay to make next block, plus reasoning.
    if (state.fees.mempoolBlocks && state.fees.mempoolBlocks.length) {
      const next = state.fees.mempoolBlocks[0];
      if (next.feeRange && next.feeRange.length) {
        const minFee = Math.min(...next.feeRange);
        const med = typeof next.medianFee === "number" ? next.medianFee : minFee;
        return { min: minFee, suggested: med, source: "mempool-blocks[0]" };
      }
    }
    if (state.fees.recommended && typeof state.fees.recommended.fastestFee === "number") {
      const fast = state.fees.recommended.fastestFee;
      return { min: fast, suggested: fast, source: "fees/recommended.fastestFee" };
    }
    return null;
  }

  // ws to refresh on every new block + tx replacement
  let ws = null;
  let wsReconnectTimer = null;
  function startWS() {
    setStatus("connecting", "连接中…");
    try {
      ws = new WebSocket(MEMPOOL_WS);
    } catch (e) {
      setStatus("closed", "无法连接");
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      setStatus("open", "已连接");
      ws.send(JSON.stringify({ action: "want", data: ["blocks", "stats", "mempool-blocks"] }));
    };
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      // New block arrived (singular "block" key, per mempool.space ws spec).
      if (msg.block && typeof msg.block.height === "number") {
        const b = msg.block;
        state.tip.height = b.height;
        state.tip.timestamp = b.timestamp;
        const detectAt = Date.now() / 1000;
        const lat = detectAt - b.timestamp;
        state.blockLatencies.unshift(lat);
        state.blockLatencies = state.blockLatencies.slice(0, 5);
        els.latLast.textContent = `#${b.height} · ${lat.toFixed(1)}s 后探测到`;
        const avg = state.blockLatencies.reduce((a, c) => a + c, 0) / state.blockLatencies.length;
        els.latAvg.textContent = `${avg.toFixed(1)}s (n=${state.blockLatencies.length})`;
        // After a new block, refresh fees + watched runes.
        fetchMempoolBlocks().then(() => {
          renderTopStats();
          if (state.currentRune) refreshRune(runeKeyOf(state.currentRune));
          refreshWatchAll();
        });
        renderTopStats();
      }
      // Initial subscribe also pushes obj.blocks (plural, recent block history).
      if (Array.isArray(msg.blocks) && msg.blocks.length) {
        const newest = msg.blocks[msg.blocks.length - 1];
        if (newest && typeof newest.height === "number" && newest.height > (state.tip.height || 0)) {
          state.tip.height = newest.height;
          state.tip.timestamp = newest.timestamp || null;
          renderTopStats();
        }
      }
      if (Array.isArray(msg["mempool-blocks"])) {
        state.fees.mempoolBlocks = msg["mempool-blocks"];
        renderTopStats();
        if (state.currentRune) renderRune(state.currentRune);
        renderWatchTable();
      }
      // mempool.space also pushes "fees" (recommended) + "mempoolInfo" updates.
      if (msg.fees && typeof msg.fees.fastestFee === "number") {
        state.fees.recommended = msg.fees;
        renderTopStats();
      }
    };
    ws.onclose = () => {
      setStatus("closed", "已断开,2s 后重连");
      scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch (e) {}
    };
  }
  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      startWS();
    }, 2000);
  }

  // ---------- Rune lookup ----------
  /** Normalize whatever the user pasted into a key the rune API understands. */
  function normalizeRuneInput(raw) {
    let s = (raw || "").trim();
    if (!s) return null;

    // Bound URL: https://app.bound.exchange/launchpad/<runeId-or-name>
    const boundMatch = s.match(/launchpad\/([^/?#]+)/i);
    if (boundMatch) s = decodeURIComponent(boundMatch[1]);

    // ord-style URL: .../rune/<name>
    const ordMatch = s.match(/\/rune\/([^/?#]+)/i);
    if (ordMatch) s = decodeURIComponent(ordMatch[1]);

    // Rune ID (block:tx) — pass through verbatim.
    if (/^\d+:\d+$/.test(s)) return s;

    // Rune NAME — strip spacers (•), whitespace, and lowercase to upper.
    s = s.replace(/[\u2022\s.\-]+/g, "").toUpperCase();

    // Names are A-Z only per the runes protocol.
    if (!/^[A-Z]+$/.test(s)) {
      // Don't reject — some indexers tolerate other input. Strip non-A-Z but
      // keep going.
      s = s.replace(/[^A-Z]/g, "");
    }
    return s || null;
  }

  function runeKeyOf(d) {
    if (!d) return null;
    if (d.id && /^\d+:\d+$/.test(d.id)) return d.id;
    if (d.entry && d.entry.spaced_rune) return d.entry.spaced_rune.replace(/\u2022/g, "");
    return null;
  }

  /** Try a list of indexers in order until one succeeds. Surfaces a clear
   *  error if every source is dead so the user knows to wait / try later. */
  async function lookupRune(rawInput) {
    const id = normalizeRuneInput(rawInput);
    if (!id) throw new Error("空的输入");

    const sources = [
      { name: "xverse", url: RUNE_API_PRIMARY + encodeURIComponent(id) },
      { name: "ordinals.com", url: RUNE_API_FALLBACK + encodeURIComponent(id) },
    ];
    const errors = [];
    for (const src of sources) {
      try {
        const r = await fetch(src.url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        const text = await r.text();
        if (!r.ok) {
          // ordinals.com famously returns 406 "JSON API disabled"; surface that
          // shorter message rather than the giant HTML body.
          const short = text.length < 80 ? text.trim() : `HTTP ${r.status}`;
          throw new Error(`${src.name} ${r.status}: ${short}`);
        }
        let data;
        try { data = JSON.parse(text); }
        catch (e) { throw new Error(`${src.name} 非 JSON 响应`); }
        if (!data || !data.entry) {
          throw new Error(`${src.name} 返回数据缺少 entry 字段`);
        }
        state.activeRuneSource = src.name;
        if (els.latApiSource) els.latApiSource.textContent = src.name;
        return data;
      } catch (e) {
        errors.push(`[${src.name}] ${e.message || e}`);
        continue;
      }
    }
    throw new Error("所有数据源都不可用 — " + errors.join(" · "));
  }

  function classifyRune(d) {
    // returns {state: 'pre'|'live'|'ended'|'closed', text}
    const e = d.entry || {};
    const terms = e.terms || null;
    const tip = state.tip.height || 0;
    if (!terms) return { state: "closed", text: "无 mint terms (premine-only)" };
    const cap = terms.cap;
    const used = e.mints || 0;
    // Cap reached? Use BigInt to compare precisely.
    if (cap !== undefined && cap !== null) {
      try {
        if (BigInt(used || 0) >= BigInt(cap)) return { state: "ended", text: "已 mint 满" };
      } catch (e) { /* fall through */ }
    }
    const hStart = (terms.height && terms.height[0]) || null;
    const hEnd = (terms.height && terms.height[1]) || null;
    if (hStart && tip && tip < hStart) {
      return { state: "pre", text: `等待开放 (距开放还有 ${hStart - tip} 块)` };
    }
    if (hEnd && tip && tip > hEnd) return { state: "ended", text: "高度窗口已关闭" };
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
    const idStr = d.id || (typeof e.block === "number" ? `${e.block}:${e.number ?? "?"}` : "—");
    els.resId.textContent = `${idStr} · 起始于 #${e.block ?? "?"} · 来源: ${state.activeRuneSource || "?"}`;

    const cls = classifyRune(d);
    els.resStatus.className = "status " + cls.state;
    els.resStatus.textContent = cls.text;

    const div = e.divisibility || 0;
    const terms = e.terms || {};
    const amount = terms.amount;
    const cap = terms.cap;
    const used = e.mints || 0;

    const dispAmount = amount !== undefined ? formatRuneNum(amount, div) : "—";
    els.mAmount.textContent = dispAmount + (e.symbol ? " " + e.symbol : "");

    // Progress: "无上限" path for sentinel-cap runes (very common).
    if (cap !== undefined && cap !== null) {
      if (isHuge(cap)) {
        els.mProgress.textContent = `${fmtNum(used)} / ∞ (无上限)`;
        els.mBar.style.width = "0%";
      } else {
        const pct = safePercent(used, cap);
        els.mProgress.textContent = `${fmtNum(used)} / ${fmtNum(Number(cap))}` +
          (pct !== null ? ` (${pct.toFixed(2)}%)` : "");
        els.mBar.style.width = (pct ?? 0) + "%";
      }
    } else {
      els.mProgress.textContent = "—";
      els.mBar.style.width = "0%";
    }

    const remaining = safeRemaining(used, cap);
    els.mRemaining.textContent = remaining !== null ? fmtNum(remaining) : "无上限";

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

  async function refreshRune(rawInput) {
    if (!rawInput) return;
    try {
      const d = await lookupRune(rawInput);
      renderRune(d);
    } catch (err) {
      console.warn("rune lookup failed", err);
      els.runeResult.classList.remove("hidden");
      els.resName.textContent = "查询失败";
      els.resId.textContent = "";
      els.resStatus.className = "status bad";
      els.resStatus.textContent = err.message || String(err);
      els.mAmount.textContent = "—";
      els.mProgress.textContent = "—";
      els.mBar.style.width = "0%";
      els.mRemaining.textContent = "—";
      els.mHeights.textContent = "—";
      const calc = computeFeeForRune();
      if (calc) {
        els.mNextFee.textContent = `${calc.fee.min.toFixed(2)} / ${calc.fee.suggested.toFixed(2)} sat/vB`;
        els.mNextFeeHint.textContent = `${calc.fee.source} · ${calc.vbytes} vB × ${calc.repeats}`;
        els.mTotalFee.textContent = `${fmtNum(calc.totalSatsSug)} sats`;
        els.mTotalFeeUsd.textContent = calc.totalUsdSug !== null ? `≈ $${fmtNum(calc.totalUsdSug, 2)}` : "—";
      }
      els.rawJson.textContent = String(err.stack || err);
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
    const key = runeKeyOf(d);
    if (!key) return;
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
    // Refresh in parallel but bounded — don't hammer indexers from a long list.
    const concurrency = 4;
    const queue = list.slice();
    async function worker() {
      while (queue.length) {
        const w = queue.shift();
        try {
          const d = await lookupRune(w.key);
          w.data = d;
        } catch (e) { /* keep stale data */ }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
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
        return `<tr><td>${escapeHtml(w.name || w.key)}</td><td>—</td><td>—</td><td>—</td><td>—</td>
          <td class="actions"><button data-act="del" data-key="${escapeAttr(w.key)}">移除</button></td></tr>`;
      }
      const cls = classifyRune(d);
      const cap = (d.entry.terms && d.entry.terms.cap) ?? null;
      const used = d.entry.mints || 0;
      let progressTxt;
      if (cap === null || cap === undefined) {
        progressTxt = "—";
      } else if (isHuge(cap)) {
        progressTxt = `${fmtNum(used)} / ∞`;
      } else {
        const pct = safePercent(used, cap);
        progressTxt = `${fmtNum(used)}/${fmtNum(Number(cap))}` +
          (pct !== null ? ` (${pct.toFixed(2)}%)` : "");
      }
      const remain = safeRemaining(used, cap);
      const remainTxt = remain !== null ? fmtNum(remain) : "无上限";
      const feeStr = calc
        ? `${calc.fee.suggested.toFixed(2)} sat/vB · ${fmtNum(calc.totalSatsSug)} sats`
        : "—";
      return `<tr>
        <td><b>${escapeHtml(d.entry.spaced_rune || w.name || w.key)}</b><div class="meta">${escapeHtml(d.id || w.key)}</div></td>
        <td><span class="status ${cls.state}">${escapeHtml(cls.text)}</span></td>
        <td>${progressTxt}</td>
        <td>${remainTxt}</td>
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
    // Periodic resilience refresh in case ws drops.
    setInterval(async () => {
      await Promise.all([fetchRecommended(), fetchMempoolBlocks()]);
      renderTopStats();
    }, 60000);
    startWS();
    renderWatchTable();
    refreshWatchAll();
  })();
})();
