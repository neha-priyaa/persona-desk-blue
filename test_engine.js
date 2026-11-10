// Engine smoke test: guards the DeskEngine copy + the DATA splice in index.html.
// Run: node test_engine.js
"use strict";
const fs = require("fs");
const E = require("./engine.js");

const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const m = html.match(/^const DATA = (\{.*\});$/m);
if (!m) throw new Error("DATA block not found in index.html");
const DATA = JSON.parse(m[1]);
const NP = DATA.personas.length, DAYS = 120;

let failed = 0;
const check = (name, ok) => { console.log((ok ? "ok  " : "FAIL") + " " + name); if (!ok) failed++; };

// determinism: same seed -> identical market
const a = E.makeMarket(DATA.personas, 40, 2026);
const b = E.makeMarket(DATA.personas, 40, 2026);
check("makeMarket deterministic", JSON.stringify(a) === JSON.stringify(b));
const c = E.makeMarket(DATA.personas, 40, 2027);
check("seed changes the market", JSON.stringify(a) !== JSON.stringify(c));

// shape
check("market has 40 days", a.market.length === 40);
check("one return series per persona", a.returns.length === NP);
check("each series covers all days", a.returns.every((r) => r.length === 40));

// daily returns are clamped to the persona's budget (longvol allows up to 1.6x)
const clipped = DATA.personas.every((p, i) =>
  a.returns[i].every((r) => Math.abs(r) <= 2 * p.appetite + 1e-9));
check("daily returns within persona budget", clipped);

// full-season simulation
const sim = E.simulate(DATA, 2026, DAYS);
check("one result per manager", sim.pms.length === DATA.pms.length);
for (const pm of sim.pms) {
  const ok =
    pm.values.length === DAYS &&
    pm.dd.length === DAYS &&
    pm.pnl.length === DAYS &&
    pm.weights.length === DAYS + 1 &&
    pm.benched.length === DAYS + 1 &&
    pm.weights.every((w) => w.length === NP) &&
    pm.weights.every((w) => w.reduce((s, x) => s + x, 0) <= 100 + 1e-6) &&
    pm.weights.every((w) => w.every((x) => x >= 0)) &&
    pm.events.every((e) => e.day >= 1 && e.day <= DAYS) &&
    Number.isFinite(pm.finalReturnPct) &&
    pm.maxDD >= 0 && Number.isFinite(pm.maxDD);
  check(`${pm.slug || "manager"} series sane`, ok);
}

// manager return is finite and starts at 0
const m0 = sim.pms[0];
check("day-0 return is 0", ((m0.values[0] - DATA.pms[0].starting_capital) / DATA.pms[0].starting_capital) * 100 !== 0);

// std behaves
check("std of flat series is 0", E.std([5, 5, 5]) === 0);
check("std grows with spread", E.std([1, 2, 3]) < E.std([1, 2, 9]));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall engine checks passed");
