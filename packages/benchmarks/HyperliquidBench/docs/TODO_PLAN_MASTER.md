Below is a ready‑to‑drop **`PLAN_TODO.md`** for **HyperLiquidBench**.
It’s organized to **win the hackathon with minimal code**, focuses the primary effort on the **Developer Tools & Public Goods** track (with a Builder Code hook for monetization), and leaves **stubs** to extend into **Programmable Trading (HyperEVM/CoreWriter)** and **HIP‑3** after judging.

> We mirror the proven three‑component pattern—**generator → runner → evaluator**—and the **Base + Bonus − Penalty** scoring you already shipped for SuiBench, so we can move fast and keep risk low. See “Step 1–4” flow, architecture, and coverage math in your deck; we reuse those ideas here.&#x20;

---

# HyperLiquidBench — PLAN\_TODO.md

## 0) Success criteria (judge‑facing)

* [ ] **Live demo (≤3 min):** run one coverage task → score; run one HiaN case → PASS/FAIL, show effect verification log.
* [ ] **Usable tool (today):** `hl-runner` + `hl-evaluator` binaries, quickstart in README, dataset on HF, GH Actions template.
* [ ] **Ecosystem impact:** other teams can drop our Action into their repos during the hackathon to guard their agents.
* [ ] **Monetizable integration (opt‑in):** `--builder-code` flag; routed flow is tagged (where supported) and logged to CSV.
* [ ] **Clear path to other tracks:** stubs & docs for HyperEVM/CoreWriter + HIP‑3 integration.

---

## 1) Project layout (create now)

```
hyperliquid-bench/
├─ crates/
│  ├─ hl-common/          # plan schema, signature types, shared utils
│  ├─ hl-runner/          # HTTP/WS client + signer + action executor
│  ├─ hl-evaluator/       # coverage score + HiaN validator
│  └─ hl-hian/            # (optional) Rust long-context generator
├─ dataset/
│  ├─ domains-hl.yaml     # domains, weights, caps, window_ms
│  ├─ tasks/              # coverage scenarios (jsonl)
│  │  └─ hl_perp_basic_01.jsonl
│  └─ hian/
│     └─ case_128k/{prompt.txt,ground_truth.json,meta.json}
├─ scripts/
│  ├─ run_cov.sh          # one-liner: run + score (coverage)
│  ├─ run_hian.sh         # one-liner: run + score (needle)
│  └─ ws_dump.sh          # dev: print raw WS stream
└─ .github/workflows/hlbench.yml  # CI template (fail on regression)
```

> This mirrors the SuiBench “Step 1–4” developer workflow and the three‑box diagram in the slides; we reuse the exact cadence: **declare metrics → execute → evaluate**.&#x20;

---

## 2) Environment & secrets

* [ ] **Rust** 1.74+ (stable), cargo workspace.
* [ ] **hyperliquid‑rust‑sdk** in `Cargo.toml` (HTTP + WS).
* [ ] `.env` (dotenv):

    * `HL_API_KEY`, `HL_API_SECRET` *(if needed for trading on testenv)*
    * `HL_ENDPOINT_HTTP`, `HL_ENDPOINT_WS` *(test or main)*
    * `HL_BUILDER_CODE` *(optional, for fee crediting)*
* [ ] **Safety for demo**: choose a test environment / restricted key with tiny limits.

---

## 3) MVP scope (what we implement this weekend)

### 3.1 Actions we must support (runner)

* [ ] **Perp order (post)** with flags: side, `tif ∈ {ALO, GTC, IOC}`, optional `reduceOnly`, size, price (absolute or mid±%).
* [ ] **Cancel**: `last_oid` (from our session), or explicit OIDs.
* [ ] **USD‑class transfer**: `toPerp` and `fromPerp` (ledger update).
* [ ] **Set leverage**: per coin (risk/margin setting).
* [ ] *(Optional)* **Spot transfer** USDC (if API avail).

**Mandatory WS subscriptions**

* [ ] `orderUpdates`, `fills`, `ledgerUpdates` (+ any user state deltas).
* [ ] Persist `isSnapshot` frames + deltas to `ws_stream.jsonl`.

**Artifacts per run**

* [ ] `plan.json` and `plan_raw.txt` (if LLM used).
* [ ] `per_action.jsonl`: one line per submitted op with correlated **effect** (see §5.3).
* [ ] `ws_stream.jsonl`: raw events (for debugging and evaluator).
* [ ] `run_meta.json`: endpoint, time, env, builder code, git SHA.
* [ ] `orders_routed.csv`: `[ts,oid,coin,side,px,sz,tif,reduceOnly,builder_code]`.

### 3.2 Evaluator scoring (coverage)

* [ ] Normalize confirmed **effects** into **signatures** like:

    * `perp.order.{tif}:{reduceOnly}:{trigger}` e.g., `ALO:false:none`, `IOC:true:none`
    * `perp.cancel.{scope}`
    * `account.usdClassTransfer.{direction}`
    * `risk.setLeverage.{coin}`
* [ ] **Base score**: weighted unique signatures per **domain** (from `domains-hl.yaml`).
* [ ] **Windowed composition bonus**: group effects by submit‑time **window\_ms** (default 200 ms). `+0.25 × max(0, distinct_in_window−1)`.
* [ ] **Penalties**:

    * **No‑op filter**: if no observable effect (e.g., tick/lot invalid → no order accepted), **0**.
    * **Per‑signature cap** (default 3) → extra repeats ignored; optionally `−0.1` beyond cap.

> “Base + Bonus − Penalty”, domain weights, and no‑op filter follow the exact coverage math from the deck; we change only the unit from “MoveCall” to “venue action”.&#x20;

### 3.3 HiaN validator

* [ ] Read `ground_truth.json`.
* [ ] Assert **exact** effects occurred (e.g., `usdClassTransfer: toPerp 25`, then `perp.order: side=sell, tif=IOC, reduceOnly=true` on `ETH`).
* [ ] Output PASS/FAIL + a compact diff.

---

## 4) Domains & dataset (create first)

### 4.1 `dataset/domains-hl.yaml`

```yaml
version: "0.1.0"
per_tx_window_ms: 200
caps: { per_signature: 3 }

domains:
  core.perp:
    weight: 1.0
    allow:
      - "perp.order.ALO:false:*"
      - "perp.order.GTC:false:*"
      - "perp.order.IOC:true:*"
      - "perp.cancel.*"
  core.account:
    weight: 1.0
    allow:
      - "account.usdClassTransfer.toPerp"
      - "account.usdClassTransfer.fromPerp"
  risk.mgmt:
    weight: 1.25
    allow:
      - "risk.setLeverage.*"
```

### 4.2 Coverage task (starter)

`dataset/tasks/hl_perp_basic_01.jsonl` (one line):

```json
{
  "id": "hl_perp_basic_01",
  "goal": "Post ALO bid 1% below mid on ETH (sz 0.01), then cancel.",
  "expected": [
    {"kind": "perp.order", "coin": "ETH", "tif": "ALO"},
    {"kind": "perp.cancel", "scope": "last_oid"}
  ]
}
```

### 4.3 HiaN case

`dataset/hian/case_128k/{prompt.txt,ground_truth.json,meta.json}`

* **prompt.txt**: long noisy context; single needle with keys.
* **ground\_truth.json**: the exact set of effects to require.
* **meta.json**: SHA256 of prompt, gen seed (repro).

> This is the same “declare metrics → create tasks → evaluate” dataset approach we used for SuiBench (“Step 1–4”, “Coverage Scoring Details”).&#x20;

---

## 5) Implementation checklist (by file)

### 5.1 `crates/hl-common`

* [ ] `plan.rs` (LLM/static)

  ```rust
  pub enum PerpTif { Gtc, Ioc, Alo }
  pub enum Trigger { None, Tp{px:f64}, Sl{px:f64} }

  pub struct PerpOrder { pub coin:String, pub bid:bool, pub px:String, pub sz:f64,
                         pub tif:PerpTif, pub reduce_only:bool, pub trigger:Trigger }

  pub enum Action {
    PerpOrders { orders: Vec<PerpOrder> },
    CancelLast,
    CancelOids { oids: Vec<u64> },
    UsdClassTransfer { to_perp: bool, usdc: f64 },
    SetLeverage { coin:String, leverage:u32 }
  }

  pub struct Plan { pub steps: Vec<Action> }
  ```
* [ ] `sig.rs` (signature serialization): `"perp.order.ALO:false:none"`, etc.
* [ ] `time.rs` (windowing): naive timestamp bucketing.

### 5.2 `crates/hl-runner`

* [ ] **Deps:** `hyperliquid-rust-sdk`, `tokio`, `serde_json`, `tracing`, `dotenvy`.
* [ ] `client.rs`:

    * `HlHttp` (orders, cancel, transfer, setLeverage).
    * `HlWs` (subscribe, stream→jsonl).
* [ ] `executor.rs`:

    * Resolve `px` strings (`mid-1%`, numbers), lot/tick normalization (round toward passive).
    * Submit actions; track `last_oid` per coin/side.
    * **Correlate effect** → write `per_action.jsonl` with `{submitted, ack, observed}`.
* [ ] `main.rs` CLI:

  ```bash
  cargo run -p hl-runner -- \
    --task dataset/tasks/hl_perp_basic_01.jsonl:1 \
    --out runs/$(date +%Y%m%d-%H%M%S) \
    ${HL_BUILDER_CODE:+--builder-code "$HL_BUILDER_CODE"}
  ```
* [ ] Builder Code plumbing: pass into post‑order call if API supports; always log into `orders_routed.csv`.

**Effect correlation rule (minimum viable):**

* If HTTP returns an OID → wait WS for the same OID **or** a fill with that OID within **2s** (configurable).
* For cancel: observe disappearance / cancel event within **2s**.
* For transfer: observe `ledgerUpdates` with matching delta.

### 5.3 `crates/hl-evaluator`

* [ ] `domains.rs`: load `domains-hl.yaml` (wildcard matcher).
* [ ] `coverage.rs`:

    * Build per‑window sets of **distinct signatures** → `bonus += 0.25 * (len−1)`.
    * Build per‑domain sets → `base += weight * uniques`.
    * Apply **caps** and **no‑op filter**.
    * Output: `eval_score.json` with `{final_score, by_domain, bonus, penalty, uniques}`.
* [ ] `hian.rs`: compare effects vs `ground_truth.json`, write `eval_hian.json`.

### 5.4 Scripts

* [ ] `scripts/run_cov.sh`

  ```bash
  set -euo pipefail
  OUT="runs/$(date +%Y%m%d-%H%M%S)"
  cargo run -p hl-runner -- --task dataset/tasks/hl_perp_basic_01.jsonl:1 --out "$OUT"
  cargo run -p hl-evaluator -- score --input "$OUT" --domains dataset/domains-hl.yaml
  jq . "$OUT/eval_score.json"
  ```
* [ ] `scripts/run_hian.sh` similarly.

---

## 6) CI (copy into `.github/workflows/hlbench.yml`)

* [ ] Matrix over scenarios; cache cargo; artifacts upload.
* [ ] **Gates**:

    * `COVERAGE_FLOOR: "3.0"` → fail if below.
    * `HIAN_REQUIRED: "true"` → fail if any HiaN case fails.

> This directly follows the CI pattern in your slide (“Builders can compose their own evaluation set… fail on regression”).&#x20;

---

## 7) Demo script (sequence you’ll perform)

1. **Coverage**: run `scripts/run_cov.sh` → show `per_action.jsonl` line for `ALO` OID + `cancel` effect; show `eval_score.json` (**≈2.25–3.5** depending on ops).
2. **HiaN**: run `scripts/run_hian.sh` → show **PASS** and the exact effect‑diff checker.
3. **“Why it matters”**: Teams can drop our GH Action **today**; their agent PRs fail if coverage regresses or HiaN breaks.
4. **Builder Code**: show `orders_routed.csv` and one‑line flag; explain monetization hook.

---

## 8) Risk log & mitigations

* **Tick/lot min size causing silent no‑op** → we normalize prices/sizes and treat no‑effect as **0 score** (visible in logs).
* **WS correlation flakes** → 2s retry window with backoff; print unresolved OIDs to stderr.
* **No localnet** → we stick to test environment & tiny sizes; make HiaN reflect *flags/sequence* more than PnL.
* **Builder Code API variance** → pass builder code when supported; otherwise, keep CSV log for attribution.
* **LLM non‑JSON** → strict schema; if invalid, **fall back to static plan** for demo (still valuable as a tool).

---

## 9) Timeline (aggressive but real)

**T+0–2h**

* [ ] Cargo workspace; add `hyperliquid-rust-sdk`.
* [ ] `hl-runner`: HTTP post order + WS subscribe; print/confirm mid‑price & 1 ALO OID.
* [ ] Dataset: `domains-hl.yaml` (core.perp, core.account, risk.mgmt).

**T+2–5h**

* [ ] Runner: cancel + transfer + setLeverage; effect correlation & `per_action.jsonl`.
* [ ] Evaluator: coverage math, `eval_score.json`.
* [ ] Script: `run_cov.sh` demo green.

**T+5–8h**

* [ ] HiaN case #1: write `prompt.txt` + `ground_truth.json`; validator PASS/FAIL.
* [ ] Script: `run_hian.sh` demo green.

**T+8–10h**

* [ ] README quickstart + HF dataset push.
* [ ] GH Actions template; add CI badge.

**T+10–12h**

* [ ] `--builder-code` plumbing; `orders_routed.csv`.
* [ ] Slides: one architecture image + scoreboard screenshot.

---

## 10) Acceptance tests (must pass before demo)

* [ ] `scripts/run_cov.sh` prints `FINAL_SCORE >= 2.25`.
* [ ] `scripts/run_hian.sh` prints `{"pass": true}` (or equivalent).
* [ ] Removing the cancel step lowers score (bonus disappears) → evaluator reacts.
* [ ] Increasing repeats beyond cap doesn’t inflate score.
* [ ] CI runs on repo fork with **no secrets** (coverage only) and passes.

---

## 11) Post‑hackathon stubs (show roadmap, keep code light)

* [ ] **Programmable Trading (HyperEVM/CoreWriter):** add `corewriter/` example that reads mid via precompile and emits a signal; evaluator consumes the on‑chain event to score coverage. *(Docs only + tiny stub for judging.)*
* [ ] **HIP‑3:** allow tasks to specify `coin:"<new_market>"`; runner fetches meta at runtime—**zero code** to add a market to the dataset.
* [ ] **Multi‑model matrix:** optional LLM plan agent; grid across `LLM_MODEL` in CI nightlies.

---

## 12) Judge sound‑bites (keep handy)

* “We don’t measure PnL; we measure **operational competence**: flags, order types, balance movements, leverage—**proven** by WS/HTTP effects.”
* “**Don’t trust, verify**: on‑chain agents must be regression‑tested in CI; our Action fails PRs when coverage dips or HiaN breaks.”
* “With `--builder-code`, our **public good monetizes itself**—anyone who adopts it credits routed flow to the builder.”

---

### Appendix A — Example commands

```bash
# Coverage
./scripts/run_cov.sh
cat runs/<ts>/eval_score.json

# HiaN
./scripts/run_hian.sh
cat runs/<ts>/eval_hian.json

# CI local dry-run
act -j hlbench --artifact-server-path ./artifacts
```

---

**References reused from SuiBench design**: Step‑wise workflow, three‑box architecture, and coverage math (Base + Bonus − Penalty) that we adapted to Hyperliquid actions.&#x20;

---

If you want, I can immediately produce the starter files (`domains-hl.yaml`, `hl_perp_basic_01.jsonl`, `run_cov.sh`, and Rust skeletons for `hl-common`/`hl-runner`/`hl-evaluator`) so you can run the first end‑to‑end score next.
