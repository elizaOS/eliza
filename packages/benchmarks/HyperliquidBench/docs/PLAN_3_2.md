Below is a ready‑to‑drop‑in **`PLAN_3_2.md`** for HyperLiquidBench — the **coverage evaluator** (Step 3.2). It specifies *what to score*, *how to normalize* runner artifacts into **signatures**, **Base + Bonus − Penalty** math, file formats, CLI, and tests, along with Rust code skeletons you can paste into a new crate (`crates/hl-evaluator`).
The scoring math follows the same blueprint you used for SuiBench (Base + Bonus − Penalty, windowed composition bonus, no‑op filter).&#x20;

---

# PLAN\_3\_2.md — HyperLiquidBench Evaluator (Coverage)

> **Goal:** Convert confirmed runner effects (from `per_action.jsonl` and optional `orders_routed.csv`) into **normalized action signatures**, then compute a deterministic **FINAL\_SCORE = Base + Bonus − Penalty** per run.&#x20;

## 0) Inputs & Outputs

**Inputs (from `hl-runner`):**

* `runs/<ts>/per_action.jsonl` — one JSON object per executed step (already logged by your runner).
* `runs/<ts>/orders_routed.csv` — optional; used for cross‑checks (OIDs, coins, etc.).
* `dataset/domains-hl.yaml` — domain weights + allowlists (see §2.3).

**Outputs (written next to inputs):**

* `runs/<ts>/eval_per_action.jsonl` — per‑step summarized effects + signatures.
* `runs/<ts>/eval_score.json` — final score, domain breakdown, bonus/penalties, unique signatures.
* `runs/<ts>/unique_signatures.json` — flat list of unique signatures seen (debug/inspection).

---

## 1) Effect → Signature normalization

We **do not** score raw API payloads. We first **normalize** each confirmed effect to a compact *signature* string. These signatures are the unit of coverage.

### 1.1 Signature vocabulary

| Action family    | Signature pattern                         | Examples                                                               |
| ---------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| Perp order       | `perp.order.{tif}:{reduceOnly}:{trigger}` | `perp.order.GTC:false:none`, `perp.order.ALO:true:none`                |
| Perp cancel      | `perp.cancel.{scope}`                     | `perp.cancel.last`, `perp.cancel.oids`, `perp.cancel.all`              |
| Account transfer | `account.usdClassTransfer.{direction}`    | `account.usdClassTransfer.toPerp`, `account.usdClassTransfer.fromPerp` |
| Risk             | `risk.setLeverage.{coin}`                 | `risk.setLeverage.BTC`, `risk.setLeverage.ETH`                         |

Notes:

* **TIF** comes from order request (`Gtc/Alo/Ioc`) — preserve case as Hyperliquid expects.
* **reduceOnly** is lowercased `true/false`.
* **trigger** is currently `none` (we’ll add `tp/sl` later when runner supports triggers).
* **scope** values: `last`, `oids`, `all`.
* **coin** is the user‑visible symbol (e.g., `BTC`, `ETH`) as provided to the order API.

### 1.2 What counts as a **confirmed effect**?

A step contributes signatures **only if**:

* `ack.status == "ok"` **and**
* for `perp_orders`: **at least one** per‑order status is **not** `"error"` (e.g., `resting`, `filled`, `success`, `waitingForFill`, `waitingForTrigger`)
  *(Your runner already produces a compact `ack` structure via `exchange_status_json()`.)*
* for cancels/transfers/setLeverage: `ack.status == "ok"` is sufficient.

**No‑op filter:** if `ack.status != "ok"` **and** there is **no** helpful `observed` WS evidence, the step is ignored (0 effect). This mirrors the *no‑op filter* used in SuiBench.&#x20;

### 1.3 Multiple orders in one step

For `perp_orders`, a single step may contain *N* orders. We produce up to *N* **signatures** (one per *accepted* order), all sharing the same `window_key_ms` (see §3.2).

---

## 2) Scoring model

**FINAL\_SCORE = Base + Bonus − Penalty**. Details mirror the deck you used before, adapted from MoveCall→venue‑action.&#x20;

### 2.1 Base (domain‑weighted uniques)

* Partition signatures into **domains** using `domains-hl.yaml` (see §2.3).
* For each domain *d*: **Base\_d = weight\[d] × |UniqueSignatures(d)|**.
* **Base = Σ\_d Base\_d**.

### 2.2 Windowed composition bonus

* Group normalized signatures by their **window key**. We **reuse** `window_key_ms` that `hl-runner` already writes on each step (floor of `submit_ts_ms` to `window_ms`, default **200 ms**).
* For each window: **`+0.25 × max(0, distinct_in_window − 1)`**.
  (Encourages composing multiple distinct actions in a tightly batched intent; exact same formula you used in SuiBench.)&#x20;

### 2.3 Domain configuration (`dataset/domains-hl.yaml`)

```yaml
version: "0.1"
per_action_window_ms: 200          # default; can be overridden by CLI
per_signature_cap: 3               # beyond this, repeats don’t add Base (see §2.4)

domains:
  perp:
    weight: 1.0
    allow:
      - "perp.order.*"
      - "perp.cancel.*"
  account:
    weight: 1.0
    allow:
      - "account.usdClassTransfer.*"
  risk:
    weight: 1.0
    allow:
      - "risk.setLeverage.*"
```

> **Matching rule:** `*` is a single‑segment wildcard (glob on the `.`‑separated parts). We match **literal strings** otherwise.

### 2.4 Penalties & caps

* **Per‑signature cap**: after **3** occurrences of the *same* signature in Base, further repeats do not increase Base. (Optional: `--repeat-penalty -0.1` per excess repeat.)
* **No‑op**: ignored (not a penalty; just not counted).
* **Future hooks:** spam penalty, per‑window duplicate suppression, model‑wide cooldown.

---

## 3) Evaluator crate layout (`crates/hl-evaluator`)

```
crates/hl-evaluator/
├── Cargo.toml
└── src/
    ├── main.rs            # CLI entry
    ├── cli.rs             # args, subcommands
    ├── config.rs          # domains-hl.yaml loader + glob matcher
    ├── model.rs           # data structs (ActionRecord, Signature, Summary, Report)
    ├── parse.rs           # read per_action.jsonl -> Effect(s)
    ├── score.rs           # Base/Bonus/Penalty engine
    └── util.rs            # io, hashing, window helpers
```

### 3.1 Cargo.toml (minimal)

```toml
[package]
name = "hl-evaluator"
version = "0.1.0"
edition = "2021"

[dependencies]
anyhow = "1"
clap = { version = "4.5", features = ["derive"] }
globset = "0.4"
indexmap = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
chrono = { version = "0.4", default-features = false, features = ["clock","std"] }
```

### 3.2 Data model (`model.rs`)

```rust
use serde::{Deserialize, Serialize};
use indexmap::IndexMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionLogRecord {
    pub step_idx: usize,
    pub action: String,
    pub submit_ts_ms: i64,
    pub window_key_ms: i64,
    pub request: serde_json::Value,
    pub ack: Option<serde_json::Value>,
    pub observed: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct Signature(pub String);

#[derive(Debug, Serialize)]
pub struct PerActionSummary {
    pub step_idx: usize,
    pub window_key_ms: i64,
    pub signatures: Vec<Signature>,
    pub ignored_noop: bool,
}

#[derive(Debug, Serialize)]
pub struct ScoreReport {
    pub final_score: f64,
    pub by_domain: IndexMap<String, f64>,
    pub bonus: f64,
    pub penalty: f64,
    pub unique_sigs: IndexMap<String, Vec<Signature>>,
    pub per_signature_counts: IndexMap<String, usize>,
}
```

### 3.3 Domain config & matching (`config.rs`)

```rust
use anyhow::{Context, Result};
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::Deserialize;
use std::{collections::HashMap, fs::File, path::Path};

#[derive(Debug, Deserialize)]
pub struct DomainsConfig {
    #[serde(default)]
    pub per_action_window_ms: Option<i64>,
    #[serde(default)]
    pub per_signature_cap: Option<usize>,
    pub domains: HashMap<String, DomainRule>,
}

#[derive(Debug, Deserialize)]
pub struct DomainRule {
    pub weight: f64,
    pub allow: Vec<String>,
}

pub struct DomainMatcher {
    rules: Vec<(String, f64, GlobSet)>,
}

impl DomainMatcher {
    pub fn new(cfg: &DomainsConfig) -> Result<Self> {
        let mut rules = Vec::new();
        for (name, rule) in &cfg.domains {
            let mut b = GlobSetBuilder::new();
            for pat in &rule.allow {
                // interpret dot-separated signature segments with '*' wildcards
                b.add(Glob::new(pat).with_context(|| format!("bad glob: {pat}"))?);
            }
            rules.push((name.clone(), rule.weight, b.build()?));
        }
        Ok(Self { rules })
    }

    pub fn classify(&self, sig: &str) -> Option<(&str, f64)> {
        for (name, weight, set) in &self.rules {
            if set.is_match(sig) {
                return Some((name.as_str(), *weight));
            }
        }
        None
    }
}

pub fn load_domains(path: &Path) -> Result<DomainsConfig> {
    let file = File::open(path).with_context(|| format!("open {:?}", path))?;
    let cfg: DomainsConfig = serde_yaml::from_reader(file).context("parse domains-hl.yaml")?;
    Ok(cfg)
}
```

### 3.4 Parsing (`parse.rs`)

```rust
use anyhow::Result;
use serde_json::Value;
use crate::model::{ActionLogRecord, PerActionSummary, Signature};

fn ack_ok(ack: &Value) -> bool {
    ack.get("status").and_then(|s| s.as_str()) == Some("ok")
}

fn per_order_statuses(ack: &Value) -> Vec<String> {
    ack.pointer("/data/statuses")
        .and_then(|v| v.as_array())
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|s| s.get("kind").and_then(|k| k.as_str()).map(|s| s.to_string()))
        .collect()
}

fn is_effectful_status(kind: &str) -> bool {
    matches!(kind, "success" | "resting" | "filled" | "waitingForFill" | "waitingForTrigger")
}

pub fn summarize(record: ActionLogRecord) -> PerActionSummary {
    let mut signatures = Vec::new();
    let mut noop = false;

    match record.action.as_str() {
        "perp_orders" => {
            let req_orders = record.request.pointer("/perp_orders/orders")
                .and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let statuses = record.ack.as_ref().map(per_order_statuses).unwrap_or_default();

            // align per-order: zip req_orders with statuses; if statuses shorter, assume ok
            for (idx, req) in req_orders.into_iter().enumerate() {
                let tif = req.get("tif").and_then(|v| v.as_str()).unwrap_or("Gtc");
                let reduce = req.get("reduceOnly").and_then(|v| v.as_bool()).unwrap_or(false);
                let trig = "none"; // future: read req["trigger"]
                let sig = format!("perp.order.{tif}:{reduce}:{trig}");

                let status_ok = statuses.get(idx)
                    .map(|k| is_effectful_status(k))
                    .unwrap_or_else(|| record.ack.as_ref().map(ack_ok).unwrap_or(false));

                if status_ok {
                    signatures.push(Signature(sig));
                }
            }
            if signatures.is_empty() && record.ack.as_ref().map(ack_ok) != Some(true) && record.observed.is_none() {
                noop = true;
            }
        }
        "cancel_last" => {
            if record.ack.as_ref().map(ack_ok) == Some(true) {
                signatures.push(Signature("perp.cancel.last".to_string()));
            } else { noop = true; }
        }
        "cancel_oids" => {
            if record.ack.as_ref().map(ack_ok) == Some(true) {
                signatures.push(Signature("perp.cancel.oids".to_string()));
            } else { noop = true; }
        }
        "cancel_all" => {
            if record.ack.as_ref().map(ack_ok) == Some(true) {
                signatures.push(Signature("perp.cancel.all".to_string()));
            } else { noop = true; }
        }
        "usd_class_transfer" => {
            if record.ack.as_ref().map(ack_ok) == Some(true) {
                let dir = record.request.pointer("/usd_class_transfer/toPerp")
                    .and_then(|v| v.as_bool()).unwrap_or(true);
                signatures.push(Signature(format!(
                    "account.usdClassTransfer.{}",
                    if dir { "toPerp" } else { "fromPerp" }
                )));
            } else { noop = true; }
        }
        "set_leverage" => {
            if record.ack.as_ref().map(ack_ok) == Some(true) {
                let coin = record.request.pointer("/set_leverage/coin")
                    .and_then(|v| v.as_str()).unwrap_or("UNKNOWN");
                signatures.push(Signature(format!("risk.setLeverage.{coin}")));
            } else { noop = true; }
        }
        _ => {}
    }

    PerActionSummary {
        step_idx: record.step_idx,
        window_key_ms: record.window_key_ms,
        signatures,
        ignored_noop: noop,
    }
}
```

### 3.5 Scoring (`score.rs`)

```rust
use crate::config::DomainMatcher;
use crate::model::{PerActionSummary, ScoreReport, Signature};
use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};

pub struct ScoreState<'a> {
    domains: &'a DomainMatcher,
    per_sig_cap: usize,
    base_by_domain: IndexMap<String, HashSet<String>>,
    counts_per_sig: HashMap<String, usize>,
    bonus_total: f64,
    penalty_total: f64,
    // for bonus:
    windows: HashMap<i64, HashSet<String>>,
}

impl<'a> ScoreState<'a> {
    pub fn new(domains: &'a DomainMatcher, per_sig_cap: usize) -> Self {
        Self {
            domains,
            per_sig_cap,
            base_by_domain: IndexMap::new(),
            counts_per_sig: HashMap::new(),
            bonus_total: 0.0,
            penalty_total: 0.0,
            windows: HashMap::new(),
        }
    }

    pub fn incorporate(&mut self, s: PerActionSummary) {
        if s.ignored_noop { return; }

        // composition window
        let w = self.windows.entry(s.window_key_ms).or_default();

        for Signature(sig) in s.signatures {
            // bonus window collects *distinct signature strings*
            w.insert(sig.clone());

            // cap counts for Base
            let c = self.counts_per_sig.entry(sig.clone()).or_insert(0);
            if *c < self.per_sig_cap {
                *c += 1;
                if let Some((d, _w)) = self.domains.classify(&sig) {
                    self.base_by_domain.entry(d.to_string()).or_default().insert(sig.clone());
                }
            } else {
                // optional: accumulate penalties for spam beyond cap
                // self.penalty_total += 0.0;
            }
        }
    }

    pub fn finalize(mut self, weights: &HashMap<String, f64>) -> ScoreReport {
        // compute bonus
        for (_win, set) in self.windows.drain() {
            let k = set.len() as i64;
            if k > 1 {
                self.bonus_total += 0.25 * (k as f64 - 1.0);
            }
        }

        // Base
        let mut by_domain = IndexMap::new();
        let mut unique = IndexMap::new();
        for (d, set) in &self.base_by_domain {
            let w = *weights.get(d).unwrap_or(&1.0);
            by_domain.insert(d.clone(), w * set.len() as f64);
            unique.insert(d.clone(), set.iter().cloned().map(Signature).collect());
        }

        let base_sum: f64 = by_domain.values().sum();
        ScoreReport {
            final_score: base_sum + self.bonus_total - self.penalty_total,
            by_domain,
            bonus: self.bonus_total,
            penalty: self.penalty_total,
            unique_sigs: unique,
            per_signature_counts: self.counts_per_sig,
        }
    }
}
```

### 3.6 CLI (`cli.rs` + `main.rs`)

```rust
// main.rs
use anyhow::Result;
#[tokio::main]
async fn main() -> Result<()> { hl_evaluator::cli::run().await }

// cli.rs
use crate::{config::{load_domains, DomainMatcher}, model::{ActionLogRecord}, parse::summarize, score::ScoreState};
use anyhow::{Context, Result};
use chrono::Utc;
use clap::Parser;
use indexmap::IndexMap;
use serde_json::Value;
use std::{fs::File, io::{BufRead, BufReader, BufWriter, Write}, path::PathBuf};
use std::collections::HashMap;

#[derive(Parser, Debug)]
#[command(about="HyperLiquidBench Evaluator (coverage)")]
pub struct Cli {
  #[arg(long)] input: PathBuf,                 // per_action.jsonl
  #[arg(long)] domains: PathBuf,               // dataset/domains-hl.yaml
  #[arg(long)] out_dir: Option<PathBuf>,
  #[arg(long)] window_ms: Option<i64>,
  #[arg(long, default_value_t=3)] cap_per_sig: usize,
}

pub async fn run() -> Result<()> {
  let cli = Cli::parse();
  let out_dir = cli.out_dir.unwrap_or_else(|| cli.input.parent().unwrap().to_path_buf());
  std::fs::create_dir_all(&out_dir)?;

  // load domains
  let cfg = load_domains(&cli.domains)?;
  let matcher = DomainMatcher::new(&cfg)?;
  let window_ms = cli.window_ms.or(cfg.per_action_window_ms).unwrap_or(200);

  let mut weights = HashMap::new();
  for (name, rule) in cfg.domains.iter() { weights.insert(name.clone(), rule.weight); }

  let eval_path = out_dir.join("eval_per_action.jsonl");
  let mut eval_writer = BufWriter::new(File::create(&eval_path)?);

  let mut state = ScoreState::new(&matcher, cli.cap_per_sig);

  // read JSONL
  let file = File::open(&cli.input).with_context(|| format!("open {:?}", cli.input))?;
  for line in BufReader::new(file).lines() {
      let line = line?;
      if line.trim().is_empty() { continue; }
      let rec: ActionLogRecord = serde_json::from_str(&line)?;
      // override window if caller demanded different window size:
      let mut rec = rec;
      if window_ms > 0 && rec.window_key_ms % window_ms != 0 {
          rec.window_key_ms = (rec.submit_ts_ms / window_ms) * window_ms;
      }
      let sum = summarize(rec);
      serde_json::to_writer(&mut eval_writer, &sum)?; eval_writer.write_all(b"\n")?;
      state.incorporate(sum);
  }
  eval_writer.flush()?;

  let report = state.finalize(&weights);
  let out = out_dir.join("eval_score.json");
  serde_json::to_writer_pretty(File::create(out)?, &report)?;
  Ok(())
}
```

---

## 4) Test plan

**Unit tests** (table‑driven):

* ✅ `perp_orders` GTC/ALO/IOC with mixed statuses (`resting`, `filled`, `error`) → only accept effectful ones; signatures mapped correctly.
* ✅ `cancel_*` with `ack.status=ok` → one signature per step.
* ✅ `usd_class_transfer` to/from perp → correct direction suffix.
* ✅ `set_leverage` emits `risk.setLeverage.{coin}`.
* ✅ **No‑op**: ack `err` and no `observed` → ignored.
* ✅ **Window bonus**: two distinct signatures in same `window_key_ms` → `+0.25`.
* ✅ **Per‑signature cap**: 4 repeats of identical `perp.order.GTC:false:none` → Base counts max 3.

**Golden run**:

* Place 2 orders (GTC false none) + cancel\_last within 200 ms window:
  Unique: `{perp.order.GTC:false:none, perp.cancel.last}` → Base `2.0`.
  Bonus: `0.25 × (2−1) = 0.25`.
  **FINAL = 2.25** (mirrors your current plateau, good sanity check).
* Add a *third* distinct signature in same window (e.g., `account.usdClassTransfer.toPerp`) → **3.5**.

---

## 5) How to run

```bash
# Build
cargo build -p hl-evaluator

# Score a run directory
RUN_DIR=$(ls -dt runs/* | head -n1)
cargo run -p hl-evaluator -- \
  --input "$RUN_DIR/per_action.jsonl" \
  --domains dataset/domains-hl.yaml \
  --out-dir "$RUN_DIR" \
  --window-ms 200 \
  --cap-per-sig 3

cat "$RUN_DIR/eval_score.json"
```

---

## 6) Edge cases & guardrails

* **Length mismatch** (`perp_orders`: N requests but M statuses): zip up to `min(N,M)`; remaining requests inherit step‑level `ack.status`.
* **Case sensitivity**: keep `TIF` title‑case (`Gtc/Alo/Ioc`) because that’s what the SDK emits; stringify exactly in signatures.
* **Coins**: treat as opaque symbols (`BTC`, `ETH`) from the request; do not lowercase unless you normalize in runner and domains.
* **WS noise**: evaluator relies primarily on `ack.status`; `observed` is only a safety valve for the **no‑op filter**.
* **Determinism**: with the same `per_action.jsonl`, same `domains-hl.yaml`, and same `window_ms`, the score is fully reproducible.

---

## 7) Why this design (rationale)

* **Direct artifact scoring**: We score **what actually happened** (ack’d effects), not intentions.
* **Windowed bonus** encourages tight, composed trading intents (equivalent to PTB composition).&#x20;
* **Domain weights** let hackathon tracks (Programmable Trading / Builder Codes / Tooling) tune what “good coverage” means.
* **Caps** prevent gaming via spam and keep coverage interpretable.

---

## 8) Next steps (follow‑ups for 3.3/3.4)

* Extend signature vocabulary: `perp.order.{...:trigger}` with `tp/sl` once runner emits triggers.
* Add **repeat penalties** and **cooldowns** (per signature / per domain).
* Publish **example `domains-hl.yaml` variants** (Bronze/Silver/Gold) to change difficulty without code changes.
* Produce a small HTML report (sparkline of windows, signatures timeline) from `eval_per_action.jsonl`.

---

**Appendix A — Example `per_action.jsonl` line (runner output)**

```json
{
  "stepIdx": 1,
  "action": "perp_orders",
  "submitTsMs": 1737465405123,
  "windowKeyMs": 1737465405000,
  "request": {
    "perp_orders": {
      "orders": [
        {"coin":"BTC","side":"buy","sz":0.01,"tif":"Gtc","reduceOnly":false,"px":"mid+0%","resolvedPx":98765.0}
      ],
      "builderCode":"myapp"
    }
  },
  "ack": { "status":"ok", "responseType":"BulkOrder", "data":{"statuses":[{"kind":"resting","oid":12345678}] } },
  "observed": [{"channel":"orderUpdates","oid":12345678,"status":"resting"}]
}
```

**Normalized signatures (evaluator):**

```
["perp.order.Gtc:false:none"]
```

---

This plan is **implementation‑ready** and consistent with your existing runner artifacts and prior SuiBench scoring philosophy. If you follow the file skeletons above, you’ll have a working `hl-evaluator` capable of producing a stable **FINAL\_SCORE** and domain breakdown for each run.
