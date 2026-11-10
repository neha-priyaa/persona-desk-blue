// Persona Desk simulation engine.
// 1) makeMarket(): seeded synthetic daily returns per trader persona (ILLUSTRATIVE ONLY).
// 2) runPM(): applies one PM persona's `rules` exactly as pm-schema.md defines them.
// Pure functions, no DOM: the page inlines this file, and test_engine.js runs it in Node.
(function (root) {
  "use strict";

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function normal(rnd) {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const pos = (x) => (x > 0 ? x : 0);

  // Daily return % of the persona's ₹50L book. B = loss budget in % (appetite × 1%).
  // Shapes by family: sellers earn small and steady with fat left tails on big-move days;
  // long-vol bleeds a little and spikes on big moves; directional rides intraday trend.
  function personaReturn(p, mk, rnd) {
    const B = p.appetite; // 1.0 == ₹50,000
    const n = normal(rnd);
    const big = Math.abs(mk.m);
    const sk = p.skill; // persona-specific edge tilt, -1..1
    let r;
    switch (p.model) {
      case "seller":
        r = B * (0.13 + 0.04 * sk + 0.13 * n - 0.36 * Math.pow(pos(big - 1.0), 1.5));
        r = clamp(r, -B, 0.45 * B);
        break;
      case "neutral":
        r = B * (0.1 + 0.04 * sk + 0.2 * n - 0.22 * Math.pow(pos(big - 1.2), 1.4));
        r = clamp(r, -B, 0.6 * B);
        break;
      case "longvol":
        r = B * (-0.08 + 0.02 * sk + 0.06 * n + 0.5 * Math.pow(pos(big - 1.15), 1.3));
        r = clamp(r, -0.5 * B, 1.6 * B);
        break;
      case "ivsignal":
        r = B * (0.07 + 0.03 * sk + 0.18 * n + 0.12 * mk.ivRev - 0.12 * pos(big - 1.6));
        r = clamp(r, -B, 0.9 * B);
        break;
      case "trend":
        r = B * (0.04 + 0.03 * sk + 0.24 * Math.tanh(mk.trend) * Math.sign(mk.m || 1) * Math.min(1, big) + 0.22 * n);
        r = clamp(r, -B, 1.1 * B);
        break;
      case "fade":
        r = B * (0.05 + 0.03 * sk + 0.2 * mk.revert + 0.22 * n);
        r = clamp(r, -B, 1.0 * B);
        break;
      case "spread":
        r = B * (0.05 + 0.03 * sk + 0.16 * Math.tanh(mk.trend) * 0.8 + 0.14 * n);
        r = clamp(r, -0.7 * B, 1.0 * B);
        break;
      default:
        r = B * (0.03 + 0.15 * n);
        r = clamp(r, -B, B);
    }
    if (p.activity < 1 && rnd() > p.activity) r = 0; // sits out
    return Math.round(r * 10000) / 10000;
  }

  function makeMarket(personas, days, seed) {
    const rnd = mulberry32(seed);
    const market = [];
    let trend = 0;
    for (let d = 0; d < days; d++) {
      let m = normal(rnd);
      if (rnd() < 0.07) m *= 2.6; // event day
      trend = 0.82 * trend + 0.55 * normal(rnd);
      market.push({ m, trend, ivRev: normal(rnd), revert: normal(rnd) });
    }
    const returns = personas.map((p) => {
      const pr = mulberry32(seed ^ hashStr(p.slug));
      const pp = Object.assign({}, p, { skill: (pr() * 2 - 1) });
      return market.map((mk) => personaReturn(pp, mk, pr));
    });
    return { market, returns }; // returns[i][d]
  }

  function std(a) {
    if (a.length < 2) return 0;
    const mu = a.reduce((s, x) => s + x, 0) / a.length;
    return Math.sqrt(a.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (a.length - 1));
  }
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const r2 = (x) => Math.round(x * 100) / 100;

  // Run one PM over the full return matrix. Weights decided after day d's close apply to d+1.
  function runPM(pm, personas, returns, personaCapital) {
    const R = pm.rules;
    const N = personas.length;
    const D = returns[0].length;
    const base = 100 / N;
    const st = personas.map(() => ({
      cum: 0, alloc: 0, peak: 0, w: base, benchedUntil: -1, cutDays: [], hist: 0, sitOut: false,
    }));
    let V = pm.starting_capital, Vpeak = V;
    const out = { values: [], dd: [], weights: [], benched: [], events: [], pnl: [] };
    // weights in force on day 0
    out.weights.push(st.map((s) => s.w));
    out.benched.push(st.map(() => false));

    for (let d = 0; d < D; d++) {
      // 1. P&L for day d with weights decided after d-1 close
      let pnl = 0;
      for (let i = 0; i < N; i++) pnl += (st[i].w / 100) * V * (returns[i][d] / 100);
      V += pnl;
      Vpeak = Math.max(Vpeak, V);
      out.pnl.push(pnl);
      out.values.push(V);
      const bookDD = ((Vpeak - V) / Vpeak) * 100;
      out.dd.push(bookDD);

      // persona series update
      for (let i = 0; i < N; i++) {
        const s = st[i];
        s.cum += returns[i][d];
        s.hist += 1;
        s.peak = Math.max(s.peak, s.cum);
      }

      const ev = (type, i, text) => out.events.push({ day: d + 1, type, i, text });

      // 2a. benched personas whose time is up return at base weight, levels reset
      for (let i = 0; i < N; i++) {
        const s = st[i];
        if (s.benchedUntil >= 0 && d + 1 >= s.benchedUntil) {
          s.benchedUntil = -1; s.w = base; s.alloc = s.cum; s.peak = s.cum;
          ev("return", i, `${personas[i].name} returns from the bench at ${r2(base)}%`);
        }
      }
      // 2b. bench
      for (let i = 0; i < N; i++) {
        const s = st[i];
        if (s.benchedUntil >= 0) continue;
        const loss = pos(s.alloc - s.cum), dd = s.peak - s.cum;
        const hitL = R.bench_loss_pct != null && loss >= R.bench_loss_pct;
        const hitD = R.bench_drawdown_pct != null && dd >= R.bench_drawdown_pct;
        if (hitL || hitD) {
          s.w = 0; s.benchedUntil = d + 1 + R.bench_days; s.sitOut = false;
          ev("bench", i, `benched ${personas[i].name} for ${R.bench_days} days (${hitL ? "loss " + r2(loss) : "drawdown " + r2(dd)} pts)`);
        }
      }
      // 2c. cut (gated by book drawdown)
      const cutsOn = (R.cut_loss_pct != null || R.cut_drawdown_pct != null) &&
        (R.cut_requires_book_drawdown_pct == null || bookDD >= R.cut_requires_book_drawdown_pct);
      if (cutsOn) {
        for (let i = 0; i < N; i++) {
          const s = st[i];
          if (s.benchedUntil >= 0 || s.sitOut) continue;
          const loss = pos(s.alloc - s.cum), dd = s.peak - s.cum;
          const hit = (R.cut_loss_pct != null && loss >= R.cut_loss_pct) ||
            (R.cut_drawdown_pct != null && dd >= R.cut_drawdown_pct);
          if (hit) {
            const nw = Math.max(R.min_weight_pct, s.w - R.cut_step_pct);
            s.cutDays.push(d);
            if (nw < s.w - 1e-9) {
              ev("cut", i, `cut ${personas[i].name} ${r2(s.w)}% → ${r2(nw)}%`);
              s.w = nw;
            }
          }
        }
      }
      // 2d. review day: style weighting
      const review = (d + 1) % R.review_every_days === 0;
      if (review) {
        const active = [];
        for (let i = 0; i < N; i++) if (st[i].benchedUntil < 0) active.push(i);
        const windowRet = (i, L) => sum(returns[i].slice(Math.max(0, d + 1 - L), d + 1));
        const cutInWindow = (i, L) => st[i].cutDays.some((cd) => cd > d - L);

        if (R.style === "equal_weight") {
          active.forEach((i) => { st[i].w = base; });
        } else if (R.style === "momentum" || R.style === "ladder") {
          const L = R.promote_lookback_days;
          active.forEach((i) => {
            const s = st[i];
            const wr = windowRet(i, L);
            const gates = s.hist >= R.promote_min_history_days &&
              !(R.promote_requires_no_cut && cutInWindow(i, L));
            if (wr > 0 && gates) {
              const nw = Math.min(R.max_weight_pct, s.w + R.promote_step_pct);
              if (nw > s.w + 1e-9) { ev("promote", i, `promoted ${personas[i].name} ${r2(s.w)}% → ${r2(nw)}%`); s.w = nw; }
            } else if (R.style === "momentum" && wr < 0) {
              const nw = Math.max(R.min_weight_pct, s.w - R.cut_step_pct);
              if (nw < s.w - 1e-9) { ev("cut", i, `trimmed ${personas[i].name} ${r2(s.w)}% → ${r2(nw)}% (negative ${L}d window)`); s.w = nw; }
            }
          });
        } else if (R.style === "inverse_vol") {
          const L = R.vol_lookback_days;
          const elig = active.filter((i) => st[i].hist >= L);
          const young = active.filter((i) => st[i].hist < L);
          young.forEach((i) => { st[i].w = base; });
          if (elig.length) {
            const inv = elig.map((i) => { const v = std(returns[i].slice(d + 1 - L, d + 1)); return v > 1e-9 ? 1 / v : 0; });
            const tot = sum(inv);
            const budget = 100 - young.length * base;
            elig.forEach((i, k) => {
              const raw = tot > 0 ? (inv[k] / tot) * budget : base;
              st[i].w = clamp(raw, R.min_weight_pct, R.max_weight_pct);
            });
          }
        } else if (R.style === "rank") {
          const L = R.rank_lookback_days;
          if (d + 1 >= L) {
            const scores = personas.map((_, i) => {
              const win = returns[i].slice(d + 1 - L, d + 1);
              const sd = std(win), mu = sum(win) / win.length;
              return { i, score: sd > 1e-9 ? mu / sd : (mu > 0 ? 99 : mu < 0 ? -99 : 0), wr: sum(win) };
            }).sort((a, b) => b.score - a.score);
            let k = 0;
            R.rank_tiers.forEach((tier, t) => {
              for (let c = 0; c < tier.count && k < scores.length; c++, k++) {
                const { i, wr } = scores[k];
                const s = st[i];
                if (s.benchedUntil >= 0) continue;
                const bottom = t === R.rank_tiers.length - 1;
                if (bottom && R.rank_bottom_bench_if_negative && wr < 0) {
                  if (!s.sitOut) ev("bench", i, `sat out ${personas[i].name} (bottom of the table, ${r2(wr)}% window)`);
                  s.w = 0; s.sitOut = true;
                } else {
                  if (s.w < tier.weight_pct - 1e-9 && s.hist > L) ev("promote", i, `ranked ${personas[i].name} #${k + 1} → ${tier.weight_pct}%`);
                  s.w = tier.weight_pct; s.sitOut = false;
                }
              }
            });
          }
        }
      }
      // 2e. rails
      for (let i = 0; i < N; i++) {
        const s = st[i];
        if (s.benchedUntil >= 0) { s.w = 0; continue; }
        if (s.hist < 5) s.w = Math.min(s.w, base);
        s.w = Math.min(s.w, 30);
      }
      const tot = sum(st.map((s) => s.w));
      if (tot > 100) st.forEach((s) => { s.w = (s.w * 100) / tot; });

      out.weights.push(st.map((s) => s.w));          // in force on day d+1
      out.benched.push(st.map((s) => s.benchedUntil >= 0 || s.sitOut));
    }
    out.finalReturnPct = ((V - pm.starting_capital) / pm.starting_capital) * 100;
    out.maxDD = Math.max(0, ...out.dd);
    return out;
  }

  function simulate(data, seed, days) {
    const mk = makeMarket(data.personas, days, seed);
    const pms = data.pms.map((pm) => runPM(pm, data.personas, mk.returns, data.persona_capital));
    return { seed, days, returns: mk.returns, market: mk.market, pms };
  }

  const api = { mulberry32, makeMarket, runPM, simulate, std };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DeskEngine = api;
})(typeof self !== "undefined" ? self : this);
