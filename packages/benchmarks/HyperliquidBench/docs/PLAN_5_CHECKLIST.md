Below is a **developer‑facing** checklist you can hand to a teammate and have them implement 1:1. It assumes the code you already shared for `hl-common` and `hl-runner` is in place. Where your current code already matches, I mark ✅; where we should add/adjust, I mark 🟨 (add) or 🟥 (change).

---

# DETAILED\_PLAN\_5.md — Implementation checklist (by file)

> Goal: finish the end‑to‑end **coverage** evaluation for HyperLiquidBench (runner → artifacts → evaluator), with deterministic scoring and scripts.

```
workspace/
├─ crates/
│  ├─ hl-common/                  # shared types, signatures, time, artifacts
│  │  └─ src/{plan.rs, artifacts.rs, sig.rs, time.rs, lib.rs}
│  ├─ hl-runner/                  # executes Plan against HL SDK, emits artifacts
│  │  └─ src/{main.rs, ...}
│  └─ hl-evaluator/               # parses artifacts, builds signatures, scores
│     └─ src/{cli.rs, model.rs, domains.rs, parse.rs, scoring.rs, util.rs, main.rs}
├─ dataset/
│  └─ domains-hl.yaml            # domain weights & prefix rules (coverage)
├─ scripts/
│  ├─ run_cov.sh
│  └─ run_cov_matrix.sh
└─ runs/                          # per-run artifacts (created at runtime)
```

---

## 5.1 `crates/hl-common` (shared)

### 5.1.1 `plan.rs` (✅ done, keep)

* Your current `Plan`, `ActionStep`, `PerpOrder`, `PerpTif`, `OrderSide`, `OrderTrigger`, `OrderPrice` are correct for the MVP.
* **Acceptance**: plan JSON must deserialize from:

  ```json
  {
    "steps": [
      { "perpOrders": { "orders": [
        { "coin": "BTC", "tif": "ALO", "side": "buy", "sz": 0.001, "reduceOnly": false, "px": "mid-0.2%" }
      ]}},
      { "cancelLast": { "coin": "BTC" } },
      { "usdClassTransfer": { "toPerp": true, "usdc": 2.0 } },
      { "setLeverage": { "coin":"BTC", "leverage":10, "cross": true } }
    ]
  }
  ```

### 5.1.2 `artifacts.rs` (✅ with 2 small tweaks)

* You already produce:

    * `per_action.jsonl` one line per submitted action with `{request, ack, observed, step_idx, submit_ts_ms, window_key_ms, notes?}`.
    * `ws_stream.jsonl` raw WS messages.
    * `orders_routed.csv` (header ok).
    * `run_meta.json` via `write_meta`.

* 🟨 **Add** `windowMs` to `run_meta.json`.

  ```rust
  // when writing meta in hl-runner (after artifacts created):
  let meta = json!({
    // ...
    "windowMs": artifacts.lock().await.window_ms(),   // <— include
    // ...
  });
  ```

* 🟨 **Guarantee flushing** on drop for `ws_stream` (optional):

  ```rust
  impl Drop for RunArtifacts {
      fn drop(&mut self) {
          let _ = self.ws_stream.flush();
          let _ = self.per_action.flush();
          let _ = self.routed_csv.flush();
      }
  }
  ```

### 5.1.3 `time.rs` (✅)

* `timestamp_ms()` + `window_start_ms()` already match the bonus windowing spec (default 200ms).

### 5.1.4 `sig.rs` (🟨 add)

Create a new module to **normalize effects into signatures** used by the evaluator.

```rust
// crates/hl-common/src/sig.rs
use serde::Serialize;

/// The normalized "coverage unit" string we count for uniqueness.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct Signature(pub String);

impl Signature {
    pub fn perp_order(tif: &str, reduce_only: bool, trigger: &str) -> Self {
        Self(format!("perp.order.{tif}:{reduce_only}:{trigger}"))
    }
    pub fn perp_cancel(scope: &str) -> Self {
        Self(format!("perp.cancel.{scope}"))
    }
    pub fn account_usd_class_transfer(direction: &str) -> Self {
        // direction ∈ {"toPerp","fromPerp"}
        Self(format!("account.usdClassTransfer.{direction}"))
    }
    pub fn risk_set_leverage(coin: &str) -> Self {
        Self(format!("risk.setLeverage.{}", coin.to_ascii_uppercase()))
    }
}

/// Utility: normalize TIF casing from request/HL SDK ("ALO"/"GTC"/"IOC").
pub fn normalize_tif(label: &str) -> &'static str {
    match label.to_ascii_uppercase().as_str() {
        "ALO" => "ALO",
        "GTC" => "GTC",
        "IOC" => "IOC",
        _ => "GTC", // safe default
    }
}

/// Utility: trigger normalization for MVP (only "none" supported by runner).
pub fn normalize_trigger(raw: &serde_json::Value) -> &'static str {
    // if later we log trigger in request: { "trigger": { "kind": "Tp", ... } }
    // For now:
    "none"
}
```

* **Acceptance**: these exact string forms are what we count and match in domains.
* Export in `hl-common/src/lib.rs`:

  ```rust
  pub mod sig;
  pub use sig::{Signature, normalize_tif, normalize_trigger};
  ```

---

## 5.2 `crates/hl-runner` (execute plan via SDK)

Your `main.rs` already:

* builds HL clients, spawns WS subscriber, executes each `ActionStep`, correlates effects, writes artifacts. ✅

**Keep the following behaviors (already present):**

* Price resolution for `"mid±X%"` with HTTP `all_mids()` cache.
* Perp post uses `bulk_order` (and `bulk_order_with_builder` if `builder_code` present).
* For each order you: compute resolved limit, build `ClientOrderRequest`, post, collect **ack OIDs**, and then **wait** for a WS confirmation (order update/fill) up to `effect_timeout_ms` (default 2000ms).
* Cancels (`cancel_last`, `cancel_oids`, `cancel_all`) match effect correlation rules (wait per OID).
* Class transfer waits for `UserNonFundingLedgerUpdates` with `AccountClassTransfer` and `to_perp` matching.
* `orders_routed.csv` row per logical order with builder code.

**Runner acceptance criteria**

* For each submitted step, one JSON line in `per_action.jsonl` with:

  ```json
  {
    "stepIdx": 0,
    "action": "perp_orders",                      // or cancel_last / cancel_oids / cancel_all / usd_class_transfer / set_leverage
    "submitTsMs": 1737459211000,
    "windowKeyMs": 1737459211000,
    "request": { ... },                           // human-readable request echo
    "ack": { "status": "ok", "data": { ... } },   // or { "status": "err", ... }
    "observed": [ { "channel": "orderUpdates", ... }, { "channel": "userFills", ... } ],
    "notes": "missing cancel confirmations for [12345]" // optional
  }
  ```
* `ws_stream.jsonl` contains every raw WS message we observed, including `isSnapshot` frames.

**Minor runner tweaks to help the evaluator**

* 🟨 In `request_value` for each `perp_orders` record, include **canonical TIF and reduceOnly** at per‑order level (you already do), and for trigger put:

  ```json
  "trigger": { "kind": "none" } // until triggers are supported
  ```
* ✅ You already add `"resolvedPx"`; keep it.
* 🟨 In `set_leverage` request echo, ensure `"coin"` is present (you already do), we will uppercase on the evaluator side.

---

## 5.3 `crates/hl-evaluator` (new)

> This crate reads a **run folder** and produces `eval_score.json` (coverage). It uses `domains-hl.yaml` to map signatures → domains and weights.

### 5.3.1 `Cargo.toml`

```toml
[package]
name = "hl-evaluator"
version = "0.1.0"
edition = "2021"

[dependencies]
anyhow = "1"
indexmap = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
regex = "1"
once_cell = "1"
chrono = { version = "0.4", default-features = false, features=["clock","std"] }
hl-common = { path = "../hl-common" }
```

### 5.3.2 `src/model.rs` (🟨)

```rust
use indexmap::IndexMap;
use serde::Serialize;
use hl_common::Signature;

#[derive(Debug, Serialize)]
pub struct ScoreMetadata {
    pub bench_version: String,           // "hlbench-v0.1"
    pub run_dir: String,                 // ./runs/<ts>
    pub domains_hash: String,            // sha256(domains-hl.yaml)
    pub window_ms: i64,
    pub per_sig_cap: usize,
}

#[derive(Debug, Serialize)]
pub struct ScoreReport {
    pub final_score: f64,
    pub by_domain: IndexMap<String, f64>,
    pub bonus: f64,
    pub penalty: f64,
    pub unique_sigs: IndexMap<String, Vec<Signature>>,  // by domain
    pub metadata: ScoreMetadata,
}

#[derive(Debug, Clone)]
pub struct EffectSample {
    pub window_key_ms: i64,
    pub signatures: Vec<Signature>,      // 1..N signatures derived from one action record
    pub is_noop: bool,                   // ack=err and no observed => no-op
}
```

### 5.3.3 `src/domains.rs` (🟨)

> Simple **prefix matcher** to map signature strings to domains.

`dataset/domains-hl.yaml`

```yaml
domains:
  perp:
    weight: 1.00
    allow:
      - "perp.order."
      - "perp.cancel."
  account:
    weight: 0.50
    allow:
      - "account.usdClassTransfer."
  risk:
    weight: 0.75
    allow:
      - "risk.setLeverage."
per_sig_cap: 3
```

Implementation:

```rust
use anyhow::{Context, Result};
use indexmap::IndexMap;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct DomainsConfig {
    pub domains: IndexMap<String, DomainRule>,
    #[serde(default)]
    pub per_sig_cap: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct DomainRule {
    pub weight: f64,
    pub allow: Vec<String>, // treated as prefixes
}

impl DomainsConfig {
    pub fn load(path: &std::path::Path) -> Result<Self> {
        let bytes = std::fs::read(path)
            .with_context(|| format!("failed to read {:?}", path))?;
        let cfg: Self = serde_yaml::from_slice(&bytes)
            .with_context(|| "failed to parse domains-hl.yaml")?;
        Ok(cfg)
    }

    pub fn domain_for(&self, sig: &str) -> Option<(&str, f64)> {
        for (name, rule) in &self.domains {
            if rule.allow.iter().any(|p| sig.starts_with(p)) {
                return Some((name.as_str(), rule.weight));
            }
        }
        None
    }
}
```

### 5.3.4 `src/parse.rs` (🟨)

> Convert `per_action.jsonl` lines to `EffectSample`.

Rules:

* **No‑op filter**: if `ack.status=="err"` **and** `observed` is absent/empty → `is_noop=true`.
* Otherwise, **derive signatures** based on `action` and `request` echo (canonical TIF, reduceOnly, trigger, coin, direction).
* For `perp_orders`, generate **one signature per order** in the step:
  `perp.order.{TIF}:{reduceOnly}:{trigger}`
* For `cancel_last`, `cancel_oids`, `cancel_all` → `perp.cancel.{scope}` with scope ∈ `last|oids|all`.
* For `usd_class_transfer` → `account.usdClassTransfer.{toPerp|fromPerp}`.
* For `set_leverage` → `risk.setLeverage.{COIN}` (uppercase).

Implementation sketch:

```rust
use anyhow::{Context, Result};
use hl_common::{Signature, normalize_tif, normalize_trigger};
use serde_json::Value;

pub fn parse_per_action_line(line: &str) -> Result<EffectSample> {
    let v: Value = serde_json::from_str(line).context("bad JSON in per_action.jsonl")?;
    let action = v["action"].as_str().unwrap_or_default();
    let window_key = v["windowKeyMs"].as_i64().unwrap_or(0);
    let ack_ok = v["ack"]["status"].as_str() == Some("ok");
    let observed_nonempty = match &v["observed"] {
        Value::Null => false,
        Value::Array(a) if a.is_empty() => false,
        _ => true,
    };

    let is_noop = !ack_ok && !observed_nonempty;

    let mut sigs = Vec::<Signature>::new();
    match action {
        "perp_orders" => {
            if let Some(orders) = v["request"]["perp_orders"]["orders"].as_array() {
                for o in orders {
                    let tif = o["tif"].as_str().map(normalize_tif).unwrap_or("GTC");
                    let reduce_only = o["reduceOnly"].as_bool().unwrap_or(false);
                    let trig = normalize_trigger(&o["trigger"]);
                    sigs.push(Signature::perp_order(tif, reduce_only, trig));
                }
            }
        }
        "cancel_last" => sigs.push(Signature::perp_cancel("last")),
        "cancel_oids" => sigs.push(Signature::perp_cancel("oids")),
        "cancel_all"  => sigs.push(Signature::perp_cancel("all")),
        "usd_class_transfer" => {
            let dir = if v["request"]["usd_class_transfer"]["toPerp"].as_bool().unwrap_or(false) {
                "toPerp"
            } else { "fromPerp" };
            sigs.push(Signature::account_usd_class_transfer(dir));
        }
        "set_leverage" => {
            let coin = v["request"]["set_leverage"]["coin"].as_str().unwrap_or("UNKNOWN");
            sigs.push(Signature::risk_set_leverage(coin));
        }
        _ => {}
    }

    Ok(EffectSample {
        window_key_ms: window_key,
        signatures: sigs,
        is_noop,
    })
}
```

### 5.3.5 `src/scoring.rs` (🟨)

**Parameters**

* `window_ms` = from `run_meta.json` (`windowMs`) or default **200** if missing.
* `per_sig_cap` = from `domains-hl.yaml` (default **3**).
* `cap_penalty` = 0.0 (MVP; wire argument later if needed).

**Algorithm**

1. **Load** `per_action.jsonl` → `Vec<EffectSample>`.
2. **Base score**: deduplicate signatures **by domain** globally:

    * let `uniq[domain]` be a `HashSet<Signature>`.
    * For every `EffectSample` that is **not** `is_noop`, add its signatures to the sets.
    * `base = Σ weight(domain) × |uniq[domain]|`.
3. **Bonus** (windowed composition):

    * Group samples by `window_key_ms`.
    * For each window, build a `HashSet<String>` of **signature strings** across all samples in that window.
    * `bonus += 0.25 × max(0, distinct_in_window − 1)`.
4. **Per‑signature cap**:

    * Count frequency `freq[sig]` across **non‑noop** samples.
    * If `freq[sig] > cap`, ignore additional repeats for any **future** bonus (already handled implicitly because bonus is per window unique) and (optionally) apply `cap_penalty` per extra. MVP: `cap_penalty = 0.0`.
5. **Final**: `final_score = base + bonus − penalty`.

**Output**

* `eval_score.json` with:

  ```json
  {
    "final_score": 3.75,
    "by_domain": { "perp": 3.0, "account": 0.25, "risk": 0.5 },
    "bonus": 0.25,
    "penalty": 0.0,
    "unique_sigs": {
      "perp": ["perp.order.ALO:false:none","perp.cancel.last"],
      "account": ["account.usdClassTransfer.toPerp"],
      "risk": ["risk.setLeverage.BTC"]
    },
    "metadata": { "bench_version":"hlbench-v0.1", "run_dir":"runs/...", "domains_hash":"...", "window_ms":200, "per_sig_cap":3 }
  }
  ```

Implementation sketch:

```rust
use anyhow::Result;
use std::collections::{HashMap, HashSet};
use indexmap::IndexMap;
use crate::{model::*, domains::DomainsConfig};
use serde_json::Value;

pub fn score_run(run_dir: &std::path::Path, domains: &DomainsConfig) -> Result<ScoreReport> {
    let per_action_path = run_dir.join("per_action.jsonl");
    let meta_path = run_dir.join("run_meta.json");

    let meta_v: Value = serde_json::from_slice(&std::fs::read(&meta_path)?)?;
    let window_ms = meta_v.get("windowMs").and_then(|v| v.as_i64()).unwrap_or(200);
    let per_sig_cap = domains.per_sig_cap.unwrap_or(3);

    // Parse samples
    let mut samples = Vec::<EffectSample>::new();
    for line in std::io::BufRead::lines(std::io::BufReader::new(std::fs::File::open(per_action_path)?)) {
        let line = line?;
        let s = crate::parse::parse_per_action_line(&line)?;
        samples.push(s);
    }

    // Base and uniques by domain
    let mut uniq: IndexMap<String, HashSet<String>> = IndexMap::new();
    let mut freq: HashMap<String, usize> = HashMap::new();

    for s in samples.iter().filter(|s| !s.is_noop) {
        for sig in &s.signatures {
            let sig_str = &sig.0;
            *freq.entry(sig_str.clone()).or_default() += 1;
            if let Some((dom, _w)) = domains.domain_for(sig_str) {
                uniq.entry(dom.to_string()).or_default().insert(sig_str.clone());
            }
        }
    }

    // Base
    let mut by_domain = IndexMap::<String, f64>::new();
    let mut base = 0.0;
    for (dom, rule) in &domains.domains {
        let count = uniq.get(dom).map(|s| s.len()).unwrap_or(0) as f64;
        let v = rule.weight * count;
        by_domain.insert(dom.clone(), v);
        base += v;
    }

    // Bonus (windowed unique signatures)
    use std::collections::BTreeMap;
    let mut windows: BTreeMap<i64, HashSet<String>> = BTreeMap::new();
    for s in samples.iter().filter(|s| !s.is_noop) {
        let set = windows.entry(s.window_key_ms).or_default();
        for sig in &s.signatures {
            set.insert(sig.0.clone());
        }
    }
    let mut bonus = 0.0;
    for (_k, set) in windows {
        let n = set.len() as i64;
        if n > 1 {
            bonus += 0.25 * (n as f64 - 1.0);
        }
    }

    // Penalty (cap only if we decide to apply)
    let mut penalty = 0.0;
    let cap = per_sig_cap;
    // MVP: penalty remains 0.0; if needed later:
    // for (sig, c) in freq {
    //     if c > cap { penalty += 0.1 * ((c - cap) as f64); }
    // }

    // unique_sigs by domain (sorted)
    let mut unique_sigs = IndexMap::<String, Vec<hl_common::Signature>>::new();
    for (dom, set) in uniq.iter() {
        let mut v: Vec<_> = set.iter().cloned().map(hl_common::Signature).collect();
        v.sort_by(|a,b| a.0.cmp(&b.0));
        unique_sigs.insert(dom.clone(), v);
    }

    let report = ScoreReport {
        final_score: base + bonus - penalty,
        by_domain,
        bonus,
        penalty,
        unique_sigs,
        metadata: ScoreMetadata {
            bench_version: "hlbench-v0.1".to_string(),
            run_dir: run_dir.display().to_string(),
            domains_hash: crate::util::sha256_file(&std::path::PathBuf::from("dataset/domains-hl.yaml"))?,
            window_ms,
            per_sig_cap: cap,
        },
    };

    Ok(report)
}
```

### 5.3.6 `src/cli.rs` and `src/main.rs` (🟨)

```rust
use anyhow::Result;
use clap::Parser;

#[derive(Parser, Debug)]
#[command(about = "HyperLiquidBench evaluator (coverage)")]
struct Cli {
    /// Path to run directory (contains per_action.jsonl, ws_stream.jsonl, run_meta.json)
    #[arg(long)]
    input: std::path::PathBuf,

    /// Path to domains-hl.yaml
    #[arg(long, default_value = "dataset/domains-hl.yaml")]
    domains: std::path::PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let cfg = crate::domains::DomainsConfig::load(&cli.domains)?;
    let report = crate::scoring::score_run(&cli.input, &cfg)?;
    let out = cli.input.join("eval_score.json");
    std::fs::write(&out, serde_json::to_string_pretty(&report)?)?;
    eprintln!("FINAL_SCORE: {}", report.final_score);
    Ok(())
}
```

### 5.3.7 `src/util.rs` (🟨 tiny helper)

```rust
use anyhow::Result;
use sha2::{Digest, Sha256};

pub fn sha256_file(path: &std::path::Path) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let mut h = Sha256::new();
    h.update(bytes);
    Ok(format!("{:x}", h.finalize()))
}
```

**Unit tests** (add a couple in `hl-evaluator/tests/`):

* `signatures_from_perp_orders.rs`: feed one `per_action.jsonl` line with two orders ALO/GTC; expect 2 signatures, no‑op=false.
* `bonus_windowing.rs`: two lines with same `windowKeyMs` and distinct signatures → bonus 0.25.
* `noop_filter.rs`: ack.status="err" and observed missing → is\_noop=true (no base/bonus).

---

## 5.4 Scripts (🟨)

### 5.4.1 `scripts/run_cov.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

OUT="runs/$(date +%Y%m%d-%H%M%S)"
PLAN="${1:-dataset/tasks/hl_perp_basic_01.jsonl:1}"
NETWORK="${NETWORK:-testnet}"

echo "[*] Running hl-runner → $OUT"
cargo run -p hl-runner -- \
  --plan "$PLAN" \
  --network "$NETWORK" \
  --out "$OUT"

echo "[*] Evaluating coverage"
cargo run -p hl-evaluator -- \
  --input "$OUT" \
  --domains dataset/domains-hl.yaml

jq . "$OUT/eval_score.json"
```

### 5.4.2 `scripts/run_cov_matrix.sh` (optional matrix across plans)

```bash
#!/usr/bin/env bash
set -euo pipefail

PLANS=(
  "dataset/tasks/hl_perp_basic_01.jsonl:1"
  "dataset/tasks/hl_perp_cancel_01.jsonl:2"
)

for P in "${PLANS[@]}"; do
  ./scripts/run_cov.sh "$P"
done
```

---

## 5.5 Acceptance checklist (copy/paste)

* [ ] Runner writes **one** action line per step in `per_action.jsonl` with `windowKeyMs`.
* [ ] Runner writes **all** WS frames to `ws_stream.jsonl` (including `isSnapshot` frames).
* [ ] Runner writes `orders_routed.csv` with header and one row per posted order.
* [ ] Runner writes `run_meta.json` including `"windowMs"`.
* [ ] Evaluator loads `domains-hl.yaml`, parses `per_action.jsonl`, and produces `eval_score.json`.
* [ ] **Base** counts are consistent: changing TIF or reduceOnly changes `perp.order.*` signature.
* [ ] **Bonus** increments by `+0.25` when ≥2 **distinct** signatures fall into the same window bucket.
* [ ] **No‑op** lines (ack err & no observed) do **not** contribute to base or bonus.
* [ ] Running `scripts/run_cov.sh` prints `FINAL_SCORE:` and pretty JSON.

---

## 5.6 “Gotchas” & invariants (read before coding)

* A **perp\_orders** step with N orders must produce **N signatures** in that sample. We do **not** fan out into multiple lines in `per_action.jsonl`; we extract inside the evaluator.
* Do **not** include `coin` in the **order** signature; uniqueness is about **behavioral variety**, not market variety. We do include `coin` in **setLeverage** signatures.
* **Windowing**: use the **precomputed** `windowKeyMs` from the runner (do not recompute).
* If **ack is ok** but **observed** is empty, still treat as **effect present** (not a no‑op). The no‑op rule only triggers when both fail (ack err & observed empty). This matches exchange behavior (e.g., accepted but low‑traffic WS).
* Domains matching is **prefix‑based**. Keep signature strings stable; future changes require updating `domains-hl.yaml`.

---

## 5.7 Example end‑to‑end (sanity)

1. Plan (JSONL line):

```json
{"steps":[
  {"perpOrders":{"orders":[
    {"coin":"BTC","tif":"ALO","side":"buy","sz":0.001,"reduceOnly":false,"px":"mid-0.3%"}
  ]}},
  {"usdClassTransfer":{"toPerp":true,"usdc":1.5}},
  {"setLeverage":{"coin":"BTC","leverage":10,"cross":true}}
]}
```

2. Run:

```bash
HL_PRIVATE_KEY=0x... ./scripts/run_cov.sh dataset/tasks/hl_perp_basic_01.jsonl:1
```

3. Expect `eval_score.json` roughly like:

```json
{
  "final_score": 2.0,                    // e.g., perp.order.ALO:false:none (1) + account.usdClassTransfer.toPerp (1)
  "by_domain": { "perp": 1.0, "account": 0.5, "risk": 0.5 },
  "bonus": 0.25,                         // if they landed in same 200ms window and were distinct
  "penalty": 0.0,
  "unique_sigs": {
    "perp": ["perp.order.ALO:false:none"],
    "account": ["account.usdClassTransfer.toPerp"],
    "risk": ["risk.setLeverage.BTC"]
  },
  "metadata": { "bench_version":"hlbench-v0.1", "window_ms":200, "per_sig_cap":3, ... }
}
```

---

With these files and exact behaviors implemented, your teammate can complete the evaluator quickly and your bench will produce **deterministic, explainable** coverage scores for HyperLiquid‑native actions with **minimal coding** beyond what you already have.
