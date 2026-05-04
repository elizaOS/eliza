Below is a *developer‑facing* spec you can drop into the repo as:

```
docs/DETAILED_PLAN_3_3.md
```

It is precise enough for another engineer to implement the **HiaN validator** end‑to‑end without further context.

---

# 3.3 HiaN (Haystack‑in‑a‑Needle) Validator — Detailed Plan

**Goal:** Given a runner output directory (with `per_action.jsonl` and `ws_stream.jsonl`) and a `ground_truth.json`, deterministically decide **PASS/FAIL** for a long‑context task by verifying that the **exact required on‑venue effects** occurred (in order), and emit a compact diff when they did not.

This validator is **orthogonal** to the coverage scorer (§3.2). It does not count diversity; it verifies *specific intent*.

---

## 0) Inputs & Outputs

### Inputs

* **`per_action.jsonl`** — one line per submitted step from the runner (already implemented in 3.1). Each line is an `ActionLogRecord`:

  ```json
  {
    "stepIdx": 0,
    "action": "usd_class_transfer",
    "submitTsMs": 1737440123456,
    "windowKeyMs": 1737440123400,
    "request": { "usd_class_transfer": { "toPerp": true, "usdc": 25.0 } },
    "ack":     { "status": "ok", "responseType": "OrderResponse", "data": ... },
    "observed": { "channel": "accountClassTransfer", "toPerp": true, "usdc": 25.0, "time": 1737440123490 },
    "notes": null
  }
  ```

  *Produced by `hl-runner` via `RunArtifacts::log_action`.*

* **`ws_stream.jsonl`** — raw websocket frames persisted by the runner (already implemented). Used as a fallback for correlating effects if a record’s `observed` field is missing.

* **`ground_truth.json`** — the answer key for this HiaN case (schema below).

### Outputs

* **Exit code**: `0` on PASS, `2` on FAIL, `1` on internal error.
* **`eval_hian.json`** — machine‑readable result:

  ```json
  {
    "pass": true,
    "matched": [
      { "expectIdx": 0, "kind": "usd_class_transfer", "matchedAt": 2, "tsMs": 1737440123456 },
      { "expectIdx": 1, "kind": "perp_order", "matchedAt": 3, "oid": 1234567890, "fill": {"px": "3875.1", "sz": "0.01"} }
    ],
    "missing": [],
    "extra": [],
    "metrics": {
      "latencyMs": { "0": 34, "1": 211 },
      "windowMs": 200
    },
    "settings": {
      "amountTolerance": 0.01,
      "pxTolerancePct": 0.2,
      "szTolerancePct": 0.5,
      "withinMs": 2000
    }
  }
  ```
* **`eval_hian_diff.txt`** — compact human diff on FAIL (see §6).

---

## 1) `ground_truth.json` schema

HiaN cases describe a **sequence** of expected effects. Each step can specify **exact** values or **matchers** with tolerances.

```jsonc
{
  "caseId": "auditor-transfer-then-sell",
  "withinMs": 2000,              // optional: max allowed gap between consecutive steps
  "windowMs": 200,               // optional: windowing to align with runner's window_key_ms
  "steps": [
    {
      "usdClassTransfer": {
        "toPerp": true,
        "usdc": { "eq": 25.0, "tol": 0.01 }  // equals within ±0.01 USDC
      }
    },
    {
      "perpOrder": {
        "coin": "ETH",
        "side": "sell",                          // exact
        "tif": "IOC",                            // exact
        "reduceOnly": true,                      // exact
        "sz": { "ge": 0.005, "le": 0.2 },        // size range (units per venue)
        // price may be absolute or relative-to-mid; we verify the *executed* price or resting px
        "px": { "mode": "abs", "val": 0 },       // mode ∈ {"abs","ignore"} — set "ignore" to skip px check
        "requireFill": true                      // if true, must see fill; else resting accepted
      }
    }
  ]
}
```

**Notes**

* For price we start conservative: **`"px": { "mode": "ignore" }`** for MVP (venues often change mid). If needed we can implement more expressive matchers later (e.g., `"mode": "midPct", "le": 0.5`).
* Add optional global defaults via flags in the CLI (`--amount-tol`, `--px-tol-pct`, …) to override per‑step fields.

---

## 2) Crate & File Layout

Add a new binary crate:

```
crates/hl-evaluator/
  Cargo.toml
  src/
    main.rs            // CLI
    cli.rs             // arg parsing
    io.rs              // file readers (jsonl streaming)
    types.rs           // GroundTruth structs, matchers
    hian.rs            // core validator logic
    diff.rs            // textual diff
    util.rs            // float tolerance helpers, parsing enums
```

The crate depends on `hl-common` for `ActionLogRecord` and time/window helpers.

---

## 3) Types (Rust)

```rust
// crates/hl-evaluator/src/types.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct GroundTruth {
    pub case_id: String,
    #[serde(default)]
    pub within_ms: Option<u64>,
    #[serde(default)]
    pub window_ms: Option<i64>,
    pub steps: Vec<ExpectStep>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ExpectStep {
    UsdClassTransfer { usd_class_transfer: ExpectTransfer },
    PerpOrder       { perp_order: ExpectPerpOrder },
    CancelLast      { cancel_last: ExpectCancelLast },
    CancelOids      { cancel_oids: ExpectCancelOids },
    CancelAll       { cancel_all: ExpectCancelAll },
    SetLeverage     { set_leverage: ExpectSetLeverage },
}

#[derive(Debug, Deserialize)]
pub struct ExpectTransfer {
    pub to_perp: bool,
    pub usdc: NumMatcher, // eq/ tol OR range
}

#[derive(Debug, Deserialize)]
pub struct ExpectPerpOrder {
    pub coin: String,
    pub side: Side,           // "buy" | "sell"
    pub tif: Tif,             // "ALO" | "GTC" | "IOC"
    pub reduce_only: bool,
    #[serde(default)] pub sz: NumMatcher,
    #[serde(default)] pub px: PxMatcher,
    #[serde(default)] pub require_fill: bool,
}

#[derive(Debug, Deserialize)]
pub struct ExpectCancelLast { pub coin: Option<String> }
#[derive(Debug, Deserialize)]
pub struct ExpectCancelOids { pub coin: String, pub oids: Vec<u64> }
#[derive(Debug, Deserialize)]
pub struct ExpectCancelAll  { pub coin: Option<String> }
#[derive(Debug, Deserialize)]
pub struct ExpectSetLeverage { pub coin: String, pub leverage: u32, #[serde(default)] pub cross: bool }

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Tif { ALO, GTC, IOC }

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side { buy, sell }

// Numeric matchers for tolerant comparisons:
#[derive(Debug, Deserialize, Default)]
#[serde(untagged)]
pub enum NumMatcher {
    // {"eq": 25.0, "tol": 0.01}
    Eq { eq: f64, #[serde(default)] tol: Option<f64> },
    // {"ge": 0.005, "le": 0.2}
    Range { #[serde(default)] ge: Option<f64>, #[serde(default)] le: Option<f64> },
    #[default]
    Any,
}

#[derive(Debug, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum PxMatcher {
    #[default]
    Ignore,                  // do not check price
    Abs { val: f64, #[serde(default)] tol: Option<f64> }, // |px - val| <= tol
    // extend later: MidPct { le: f64, ge: Option<f64> }
}

// Results
#[derive(Debug, Serialize)]
pub struct HianResult {
    pub pass: bool,
    pub matched: Vec<MatchEntry>,
    pub missing: Vec<MissingEntry>,
    pub extra: Vec<usize>, // unmatched action indices if we ever enforce "exactly K"
    pub metrics: serde_json::Value,
    pub settings: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct MatchEntry {
    pub expect_idx: usize,
    pub kind: String,
    pub matched_at: usize, // per_action line number (0-based)
    pub ts_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct MissingEntry {
    pub expect_idx: usize,
    pub kind: String,
    pub reason: String,
}
```

---

## 4) CLI

```rust
// crates/hl-evaluator/src/cli.rs
use clap::Parser;

#[derive(Parser, Debug)]
#[command(about = "HyperLiquidBench evaluator (HiaN)")]
pub struct Cli {
    /// Path to ground_truth.json
    #[arg(long)]
    pub ground: std::path::PathBuf,
    /// Path to per_action.jsonl (runner output)
    #[arg(long)]
    pub per_action: std::path::PathBuf,
    /// Optional path to ws_stream.jsonl (for fallback observation)
    #[arg(long)]
    pub ws_stream: Option<std::path::PathBuf>,
    /// Output directory (defaults to per_action's parent)
    #[arg(long)]
    pub out_dir: Option<std::path::PathBuf>,

    // Global tolerances (override file if set)
    #[arg(long)] pub amount_tol: Option<f64>,      // USDC absolute tol
    #[arg(long)] pub px_tol: Option<f64>,          // absolute price tol
    #[arg(long)] pub sz_ge: Option<f64>,           // default sz lower bound
    #[arg(long)] pub within_ms: Option<u64>,       // inter-step time bound
    #[arg(long, default_value_t = 200)] pub window_ms: i64,
}
```

`main.rs` wires `Cli` → `hian::evaluate()` and writes `eval_hian.json` + prints `PASS`/`FAIL`.

---

## 5) Core Logic

### 5.1 Read & normalize artifacts

* Implement `io::read_per_action(path) -> Vec<ActionLogRecord>` by reading the JSONL file line by line (avoid loading `ws_stream.jsonl` unless needed).
* Validate each `ActionLogRecord` has `action` ∈ the allowed set:

    * `perp_orders`, `cancel_last`, `cancel_oids`, `cancel_all`, `usd_class_transfer`, `set_leverage`.
* For matching, we **prefer `observed`**. If absent, try to reconstruct from `ack` or by scanning the fallback `ws_stream.jsonl` for a matching event near `submitTsMs` (±1s) using `window_key_ms` to narrow.

### 5.2 Matching strategy (ordered sequence)

We match **in order** across `ground_truth.steps`.

Algorithm:

```rust
let mut cursor = 0usize; // index into per_action vector
for (i, expect) in truth.steps.iter().enumerate() {
    // search forward from cursor for the first action that matches `expect`
    match find_match(expect, &actions[cursor..], config) {
        Some((rel_idx, match_info)) => {
            let idx = cursor + rel_idx;
            // enforce inter-step temporal constraint if within_ms set
            if i > 0 && config.within_ms.is_some() {
                let prev_ts = matched.last().unwrap().ts_ms;
                let now_ts  = actions[idx].submit_ts_ms;
                if now_ts as u64 - prev_ts as u64 > config.within_ms.unwrap() {
                    return FAIL("exceeded withinMs between steps i-1 and i")
                }
            }
            record_match(i, idx, match_info);
            cursor = idx + 1; // continue after the matched action
        }
        None => record_missing(i, expect, "no matching action observed in tail"),
    }
}
```

We do **not** require that there are no extra actions; we only care that *all expected* effects occur in sequence. (We can add a strict mode later.)

### 5.3 Effect extractors

Implement in `hian.rs`:

```rust
fn match_transfer(expect: &ExpectTransfer, act: &ActionLogRecord, cfg: &Cfg) -> Option<MatchEntry>;
fn match_perp_order(expect: &ExpectPerpOrder, act: &ActionLogRecord, cfg: &Cfg) -> Option<MatchEntry>;
fn match_cancel_last(expect: &ExpectCancelLast, act: &ActionLogRecord) -> Option<MatchEntry>;
fn match_cancel_oids(expect: &ExpectCancelOids, act: &ActionLogRecord) -> Option<MatchEntry>;
fn match_cancel_all(expect: &ExpectCancelAll, act: &ActionLogRecord) -> Option<MatchEntry>;
fn match_set_leverage(expect: &ExpectSetLeverage, act: &ActionLogRecord) -> Option<MatchEntry>;
```

**Rules per kind:**

* **`usd_class_transfer`**

    * `act.action == "usd_class_transfer"` is required.
    * Use `act.observed` if present, with shape:

      ```json
      { "channel": "accountClassTransfer", "toPerp": true, "usdc": 25.0, "time": ... }
      ```
    * Check `toPerp` equals, and `NumMatcher` against `usdc` (respect `amount_tol` override).
    * Return `MatchEntry { ts_ms: act.submit_ts_ms }`.

* **`perp_order`**

    * `act.action == "perp_orders"` is required.
    * Read `act.request.perp_orders.orders` vector and the corresponding `observed` (array of `orderUpdates`/`userFills`) and/or `ack`.
    * We consider a match if **any single order** in this batch satisfies:

        * `coin`, `side`, `tif`, `reduceOnly` equal (case‑insensitive for coin).
        * `sz` satisfied by `NumMatcher` (if `Any`, skip).
        * If `requireFill == true`, we must see at least one `userFills` event for this order ID (`oid`) in `observed`. Otherwise:

            * Accept `Resting` or `Filled` in `ack.data.statuses`.
    * Extract `oid` from `ack` (when status is `Resting`/`Filled`) using current helper `extract_oids` + per‑order index; fallback: parse from `observed` entry.
    * Price (`px`) — for MVP with `"mode": "ignore"` do nothing. If `"Abs"` supplied: accept if `|executed_px - val| <= tol` (use `fill.px` when filled; else, use `request.resolvedPx`).
    * Return `MatchEntry { oid, ts_ms, fill: Some({px, sz}) if filled }`.

* **`cancel_last` / `cancel_oids` / `cancel_all`**

    * `act.action` must match the expected cancel kind.
    * For `cancel_last` with `coin: Some("ETH")`, the *request* must include the same coin; for `None`, accept any.
    * For `cancel_oids`, compare the set of oids in `request` with expected `oids`.
    * For `cancel_all`, if `coin: Some`, require the same coin in `request`.
    * If `ack.status == "ok"`, treat as success (do not require WS confirm for MVP).

* **`set_leverage`**

    * `act.action == "set_leverage"`.
    * Compare `coin`, `leverage`, `cross` exactly (from `request`).
    * If `ack.status == "ok"`, accept; else fail.

### 5.4 Utility matchers

```rust
fn num_match(m: &NumMatcher, val: f64, defaults: &Defaults) -> bool {
    match m {
        NumMatcher::Eq { eq, tol } => (val - *eq).abs() <= tol.unwrap_or(defaults.amount_tol),
        NumMatcher::Range { ge, le } => {
            let ok_ge = ge.map(|g| val >= g).unwrap_or(true);
            let ok_le = le.map(|l| val <= l).unwrap_or(true);
            ok_ge && ok_le
        }
        NumMatcher::Any => true,
    }
}
```

---

## 6) Diff on FAIL (compact)

`diff.rs` builds a short text file `eval_hian_diff.txt`:

```
HiaN FAIL (case auditor-transfer-then-sell)

Step 0 expected: usd_class_transfer { toPerp: true, usdc ~= 25.00±0.01 }
  ✗ Not found after action #1
  Nearby events (±3):
    #1 cancel_all { coin: "ETH" } @1737440123000
    #2 usd_class_transfer { toPerp: true, usdc: 5.00 } @1737440123400  <-- amount mismatch
    #3 perp_orders { coin: "ETH", side: "sell", tif: "IOC", sz: 0.01 } @1737440123456

Step 1 expected: perp_order { coin: "ETH", side: sell, tif: IOC, reduceOnly: true, requireFill: true }
  ✓ Matched at action #3, oid=1234567890, fill px=3875.1 sz=0.01
```

Implementation hints:

* For a missing step, scan up to ±3 actions around `cursor` and print a one‑line summary derived from `request`.
* Use emoji ticks/crosses for readability in terminal.

---

## 7) Tuning & Config

* CLI overrides:

    * `--within-ms`: enforce inter‑step maximum gap (default: from `ground_truth.json` if present).
    * `--amount-tol`, `--px-tol`, etc. override defaults used in `NumMatcher::Eq`/`PxMatcher::Abs`.
    * `--window-ms`: provide default if not present in truth file; also used to compute *latency per match* (`observed.time - submitTsMs`, rounded to window buckets).

* Result metrics:

    * For each matched step: record `latencyMs[i] = max(0, observed.time - submitTsMs)` if available; else `null`.
    * Persist settings used so that runs are reproducible.

---

## 8) Tests

Add `crates/hl-evaluator/tests/hian.rs` with fixtures.

* **Fixture 1 — PASS minimal**

    * `per_action.jsonl`:

        1. `usd_class_transfer` observed `{toPerp:true, usdc:25.0}`
        2. `perp_orders` observed `userFills` `{coin:"ETH", side:"sell", tif:"IOC", sz:"0.01", px:"3875.1", oid: 1}`
    * `ground_truth.json` as in §1.
    * Assert `pass == true`, `matched.len()==2`.

* **Fixture 2 — FAIL amount off**

    * Same as above but transfer `usdc: 24.9` with `tol: 0.01`.
    * Assert `pass == false`, `missing[0].reason` contains `amount`.

* **Fixture 3 — FAIL no fill required**

    * Expect `requireFill: true` but only `Resting` ack and no `userFills`.
    * Assert `pass == false`.

* **Fixture 4 — Range matchers**

    * `sz: {"ge":0.005,"le":0.02}` with `sz=0.01` → PASS.

---

## 9) Example wiring (CLI main)

```rust
// crates/hl-evaluator/src/main.rs
use anyhow::Result;

mod cli;  mod io;  mod types;  mod hian;  mod diff;  mod util;

#[tokio::main]
async fn main() -> Result<()> {
    let args = cli::Cli::parse();
    let (result, out_dir) = hian::evaluate(args).await?;
    let out = out_dir.join("eval_hian.json");
    std::fs::write(&out, serde_json::to_string_pretty(&result)?)?;
    println!("{}", if result.pass { "PASS" } else { "FAIL" });
    std::process::exit(if result.pass {0} else {2});
}
```

---

## 10) Acceptance Criteria (MVP)

* [ ] `hl-evaluator` builds as a standalone binary.
* [ ] `hl-evaluator hian --ground runs/<ts>/ground_truth.json --per-action runs/<ts>/per_action.jsonl` produces `eval_hian.json` and **prints PASS/FAIL**.
* [ ] **Ordered matching** is enforced, with optional `withinMs` constraint.
* [ ] Uses `observed` first; gracefully falls back to `ack`.
* [ ] Numeric comparisons respect matchers & tolerances.
* [ ] On FAIL, `eval_hian_diff.txt` is created with a concise explanation.
* [ ] Unit tests cover PASS/FAIL paths and tolerance edge cases.

---

## 11) Stretch (post‑MVP)

* **Price match vs. mid**: introduce `PxMatcher::MidPct { le, ge }` and compute against a cached `resolvedPx` or a `mid` snapshot captured by the runner.
* **Strict mode**: `--exact-k` to require no extraneous actions; generate `extra` entries.
* **Multi‑order step**: add `"count": "atLeastOne" | "exactN"`.
* **Latencies**: include p50/p95 of WS confirmation times.

---

## 12) Developer Notes

* Keep the validator **pure read‑only**: it must not hit the network.
* Treat all floats as `f64`, and **never** compare floats for exact equality; always use given tolerances or sensible defaults.
* Defensive JSON parsing: values in `ack`/`observed` may be strings; parse to numbers with fallbacks.

---

## 13) Quick Run

```bash
# After running hl-runner and producing runs/<ts>/...
cargo run -p hl-evaluator -- hian \
  --ground runs/<ts>/ground_truth.json \
  --per-action runs/<ts>/per_action.jsonl
# -> prints PASS/FAIL and writes runs/<ts>/eval_hian.json
```

---

This plan mirrors the artifacts emitted by the runner (3.1), adds a deterministic sequence‑matcher over venue effects, and produces actionable diagnostics that make HiaN tasks verifiable and repeatable.
