Below is a **re‑scoped, prize‑oriented, minimal‑coding** **DETAILED\_TECHSPEC** for **HyperLiquidBench** that explicitly maps to the hackathon tracks you shared (Programmable Trading / HIP‑3 / Builder Codes / Developer Tools), shows *how this wins*, and reuses as much of the SuiBench pattern as possible so we can ship fast.

> **Key tactic for 1st place with minimal code:** ship a *public good* (Developer Tools) that other teams immediately use **during the hackathon** to validate their bots/contracts—and add a tiny **Builder Code** hook so every run that routes order‑flow to Hyperliquid credits your team. Optional “Phase‑2” stubs show how the same bench extends to **Programmable Trading (HyperEVM/CoreWriter)** and **HIP‑3** markets without heavy implementation this weekend.

---

## 0) One‑liner & Why this wins

**HyperLiquidBench** is a **Rust‑native**, reproducible benchmark + dataset that scores on‑venue *operational competence* of trading agents: placing/cancelling orders with correct flags, moving balances, managing leverage, and proving effects via live WS streams. It ships as:

* a CLI **runner** (executes plans via Hyperliquid Rust SDK + HTTP/WS),
* a CLI **evaluator** (unique‑action coverage score + “needle” pass/fail),
* a public **dataset** on Hugging Face, and
* a **Builder Code** switch (optional) that tags routed flow for revenue share.

**Win story:**

* **Developer Tools & Public Goods:** usable *today* by all teams to verify their agents in CI; clear “don’t trust, verify” value. (Judges love tools everyone used.)
* **Builder Codes & Monetizable Integrations:** one env var credits trade routing—turns the tool into a monetizable integration w/ direct protocol incentives.
* **Programmable Trading (HyperEVM/CoreWriter) & HIP‑3:** we show *ready stubs* and dataset hooks so the bench naturally expands to these tracks on Monday without big rewrites (strong future‑impact narrative).

> We reuse a proven three‑box design (generator → runner → evaluator) and the scoring math already demonstrated in SuiBench to move fast and keep the code surface small. See the *workflow diagram* and *scoring slide* in your SuiBench deck—we mirror that structure here.&#x20;

---

## 1) Track alignment (explicit)

### A. **Developer Tools & Public Goods** (primary track to win)

* **What we ship:** `hl-runner` + `hl-evaluator` + dataset + GitHub Action.
* **Why it matters:** teams and judges can *verify* agent correctness (not PnL) before demo; reproducible score + pass/fail needle.
* **Evidence of impact:** publish HF dataset + GH Action template; live scoreboard in README; 5‑minute demo run.

> This mirrors your SuiBench flow—declare metrics, run the test, get the score & report; the doc’s “High‑Level Architecture” and “Coverage Scoring Details” pages translate 1:1 here.&#x20;

### B. **Builder Codes & Monetizable Integrations**

* **Feature:** `--builder-code <CODE>` env/flag; the runner attaches the code to order posts (where supported) so routed trades credit your builder identity.
* **Deliverable:** simple CSV “orders\_routed.csv” per run with fee attribution; README “How to add your builder code”.

### C. **Programmable Trading — HyperEVM & CoreWriter (phase‑2 stub)**

* **We avoid heavy coding now:** ship an interface spec + mock *CoreWriter harness* that records “on‑chain planner intent” and validates the same coverage rules. Provide one “Hello‑CoreWriter” example that only reads mid‑price via precompile and emits a dummy signal (no full strategy).
* **Why judges care:** clear pathway to move *the same* benchmark rules into smart‑contract trading logic.

### D. **HIP‑3 — Builder‑Deployed Perpetual Markets (phase‑2 ready)**

* **Dataset hook:** tasks accept `{coin:"<NEW/HIP3 market>"}` and the runner pulls metadata at runtime, so adding a HIP‑3 market is **zero code** (just a new line in the JSONL).

---

## 2) What exactly do we evaluate?

Two complementary tracks—identical to your SuiBench *coverage* vs *long‑context* philosophy, adapted to Hyperliquid primitives:

1. **Coverage & Composition (FINAL\_SCORE)**
   *Breadth across distinct, correctly executed venue actions + bonus for composing them into coherent windows.*

    * **Operation signatures** we count (examples):

        * `perp.order.{tif}:{reduceOnly}:{trigger}` (e.g., `ALO:false:none`, `IOC:true:none`)
        * `perp.cancel.{scope}` (all / ids / last\_oid)
        * `account.usdClassTransfer.{direction}` (toPerp / fromPerp)
        * `risk.setLeverage.{coin}`
        * `spot.transfer.{token}` (optional extension)

    * **Proof of effect** (must observe via WS/HTTP after post):

        * Orders → resting OID or fill on `orderUpdates`/`fills`
        * Cancels → OID disappears / `nonUserCancel` event
        * Transfers/leverage → `ledgerUpdates` / `userState` delta

    * **Composition bonus** within a short *batch window* (default 200 ms): each extra **distinct** op in the same window adds **+0.25**.

    * **No‑op filter + penalties**: retries with no effect (e.g., violating min lot/tick) don’t score; spam beyond per‑signature cap may subtract.

   > We are copying the *FINAL\_SCORE = Base + Bonus − Penalty* approach and the “distinct signature counting per domain + PTB composition bonus” structure from your SuiBench scoring slide.&#x20;

2. **HiaN (Operation Needle) — Pass/Fail**
   *In a long, noisy prompt, find the single actionable instruction + parameters and execute exactly that; evaluator checks effects.*

    * Example needle: “Transfer **25 USDC** to **perp** balance, then place a **reduceOnly** **IOC** sell on **ETH** at **market**.”

    * **Pass** iff we see the ledger transfer and a correctly flagged order (side/coin/IOC/reduceOnly), with either a fill or valid IOC outcome.

   > Exactly the “accuracy under noise / position sensitivity / context durability” rationale you used in SuiBench LC track—just with Hyperliquid actions.&#x20;

---

## 3) Minimal‑coding architecture (Rust‑first)

```
hyperliquid-bench/
├─ crates/
│  ├─ hl-common/        # plan schema, signatures, scoring structs
│  ├─ hl-runner/        # HTTP/WS client + signer + action executor
│  ├─ hl-evaluator/     # coverage scorer + HiaN validator
│  └─ hl-hian/          # (optional) long-context generator (Rust)
├─ dataset/
│  ├─ domains-hl.yaml   # domains, weights, caps, window_ms
│  ├─ tasks/*.jsonl     # coverage scenarios (perps, transfer, cancel)
│  └─ hian/*            # prompt.txt, ground_truth.json, meta.json
└─ .github/workflows/hlbench.yml  # CI template (fail on regression)
```

* **Runner (hl‑runner)**

    * Uses **Hyperliquid Rust SDK** (and keeps a tiny fallback signer if needed).
    * **WS**: subscribe to `orderUpdates`, `fills`, `ledgerUpdates`; persist **isSnapshot** + deltas; optional WS `post` wrapper for actions.
    * **Nonces & batching**: simple atomic counter + *windowed* submission (so we get multi‑op bonus with one run).
    * **Artifacts**:

        * `per_action.jsonl` (HTTP/WS acks + resolved action → effect)
        * `ws_stream.jsonl` (raw stream events)
        * `plan.json` / `plan_raw.txt` (LLM or static)
        * `run_meta.json` (env, time, model)

* **Evaluator (hl‑evaluator)**

    * **Coverage**: normalize confirmed effects → map to signatures → attribute to **domains** from `domains-hl.yaml` → compute **Base + Bonus − Penalty** with per‑signature caps.
    * **HiaN**: strict comparison of effects vs `ground_truth.json` (binary pass/fail + diff report).

> This mirrors your SuiBench diagram: generator → runner → evaluator; you already showed judges this model is practical and reproducible.&#x20;

---

## 4) Dataset (Hugging Face‑ready)

### 4.1 `domains-hl.yaml` (example)

```yaml
version: "0.1.0"
per_tx_window_ms: 200    # composition window
caps: { per_signature: 3 }

domains:
  core.perp:
    weight: 1.0
    allow:
      - type: perp.order.ALO:false:none
      - type: perp.order.GTC:false:none
      - type: perp.order.IOC:true:none
      - type: perp.cancel.*
  core.account:
    weight: 1.0
    allow:
      - type: account.usdClassTransfer.toPerp
      - type: account.usdClassTransfer.fromPerp
  risk.mgmt:
    weight: 1.25
    allow:
      - type: risk.setLeverage.*
  spot.transfer:          # optional extension on Sunday
    weight: 1.25
    allow:
      - type: spot.transfer.USDC
```

### 4.2 Coverage tasks (`dataset/tasks/*.jsonl`)

Each line is a minimal spec the agent can satisfy in many ways.

```json
{
  "id": "hl_perp_basic_01",
  "goal": "Place a post-only bid 1% below mid on ETH perps (sz 0.01), then cancel it.",
  "constraints": {"maxWindows": 2},
  "expected": [
    {"kind": "perp.order", "coin": "ETH", "tif": "ALO"},
    {"kind": "perp.cancel", "scope": "last_oid"}
  ]
}
```

### 4.3 HiaN case (`dataset/hian/case_128k/`)

* `prompt.txt` — long noisy text with a single **needle** + **keys**.
* `ground_truth.json` — exact effects required.
* `meta.json` — SHA256 prompt, seeds (repro).

> Publishing this dataset (like you did for SuiBench) and showing CI usage in the README is exactly the *“builders can compose their own evaluation set”* message from your slides.&#x20;

---

## 5) LLM plan (optional, but 5 lines of glue)

**Strict JSON schema** (so we don’t write an IR):

```json
{
  "steps": [
    { "perp_order": { "coin":"ETH", "side":"buy", "tif":"ALO", "px":"mid-1%", "sz":"0.01", "reduceOnly": false } },
    { "cancel": { "scope":"last_oid" } },
    { "usd_class_transfer": { "direction":"toPerp", "usdc":"25" } }
  ],
  "hints": { "tick_lot":"auto", "batch_window_ms":150 }
}
```

**Prompt rules (system):**

* Output **JSON only** (no code fences).
* Respect tick/lot/min size; never invent fields.
* If scenario asks for IOC/reduceOnly/ALO, you **must** set it.
* If it says “HIP‑3 market M”, use coin `M` (runner auto‑discovers meta).

> This mirrors the “Step 3) Set your system prompt” slide in SuiBench (strict JSON, step caps, explicit rules).&#x20;

---

## 6) CLI & CI (copy‑paste usable)

**Run coverage (static task):**

```bash
cargo run -p hl-runner -- \
  --task dataset/tasks/hl_perp_basic_01.jsonl:1 \
  --out runs/$(date +%Y%m%d-%H%M%S) \
  ${BUILDER_CODE:+--builder-code "$BUILDER_CODE"}

cargo run -p hl-evaluator -- \
  score --input runs/<ts> --domains dataset/domains-hl.yaml
```

**Run HiaN:**

```bash
cargo run -p hl-runner -- --hian dataset/hian/case_128k --out runs/<ts>
cargo run -p hl-evaluator -- hian --input runs/<ts> --ground dataset/hian/case_128k/ground_truth.json
```

**GitHub Actions gate (public goods!)**

* `COVERAGE_FLOOR: "≥3.0"`
* `HIAN_REQUIRED: "true"`
* Upload artifacts (`per_action.jsonl`, `ws_stream.jsonl`, score JSON).

> Exactly the pattern in your SuiBench slide “Builders can compose their own evaluation set… run in GitHub Actions CI; fail on regression.”&#x20;

---

## 7) “How little do we code?”

* **Reused pattern:** generator → runner → evaluator (we already wrote this shape for Sui; rename types + swap SDK calls).&#x20;
* **Minimal runner:** one HTTP client, one WS client, one signer, a handful of actions (order, cancel, usdClassTransfer, setLeverage).
* **Evaluator:** same unique‑signature counter + window bonus logic you shipped; just change the signature key to `perp.order.*`, etc.&#x20;
* **HiaN:** one prompt file + one ground truth; validator checks ledger + order flags.

---

## 8) Deliverables checklist (what judges will see)

* ✅ `hl-runner` + `hl-evaluator` binaries (Rust)
* ✅ `dataset/domains-hl.yaml`, `dataset/tasks/*.jsonl`
* ✅ `dataset/hian/case_128k/{prompt.txt,ground_truth.json,meta.json}`
* ✅ **README**: quickstart + CI badge + sample scores (and “how to add your Builder Code”)
* ✅ **Short demo** (3 mins): run coverage → score; run HiaN → pass
* ✅ **(Optional)** CoreWriter/HyperEVM demo stub (read mid via precompile; show how the bench would verify an on‑chain strategy)
* ✅ **(Optional)** HIP‑3 market task line (no code; just shows auto‑discovery)

---

## 9) Scoring math (for the README)

```
Base   = Σ_domain ( weight[d] × unique_signatures[d] )
Bonus  = Σ_windows ( 0.25 × max(0, unique_ops_in_window − 1) )
Penalty= repeats beyond per_signature cap, invalid/no-op attempts
FINAL_SCORE = Base + Bonus − Penalty
```

> This is the same formula your slide expresses for SuiBench coverage (Base + Bonus − Penalty). We merely replace “MoveCall signatures” with “venue action signatures.”&#x20;

---

## 10) Anti‑gaming & safety rails

* **Effect required** (resting/fill/ledger/state) or no score.
* **Per‑signature cap** (default 3) to stop spam.
* **Windowed bonus** so random concurrency doesn’t inflate composition.
* **LLM strict JSON**; if LLM fails, we fall back to a *static* plan for the demo.
* **Builder Code switch** is opt‑in (no secret keys needed to judge the tool).

---

## 11) Timeline (hackathon‑realistic)

* **T+3h**: runner skeleton (sign, HTTP order, WS subscribe) + one coverage task.
* **T+7h**: evaluator (unique signature + bonus) + `domains-hl.yaml`.
* **T+10h**: HiaN #1 (prompt/ground truth) + validator.
* **T+12h**: README, CI workflow, sample scores, slide.
* **T+16h**: Builder Code flag + routed‑flow CSV; optional HIP‑3 task line.
* **(Stretch)**: CoreWriter “hello” stub.

---

## 12) Judge‑ready narrative (why it’s valuable)

* **Don’t trust, verify**: On‑chain agents must prove *operational* correctness (flags, nonces, balance routing) before anyone lets them run funds. This tool makes that a **unit test** for agents. (You used this exact argument in your SuiBench deck; we’re repeating it venue‑specifically for Hyperliquid.)&#x20;
* **Ecosystem leverage**: Every team can run it in CI—fewer broken demos, more reliable bots.
* **Incentive alignment**: Builder Codes turn a public good into a self‑sustaining integration (your tool earns fees as others adopt it).
* **Future‑proof**: HIP‑3/HyperEVM extensions show this can grade *contracts* and *new markets* with the same runner/evaluator.

---

## 13) Acceptance tests (what we’ll demo live)

1. **Coverage run**:

    * ALO bid 1% below mid → resting OID
    * Cancel last OID → removed on WS
    * (Optional) usdClassTransfer 25 USDC → ledger entry
      → Evaluator prints **FINAL\_SCORE ≈ 2.25–3.5** depending on op mix.

2. **HiaN run**:

    * Long prompt, one needle: “IOC reduceOnly sell after transfer”
      → Evaluator prints **PASS** + effect diff.

3. **CI view**:

    * Open the PR; see job fail if `FINAL_SCORE < 3.0` or HiaN fails.

---

### Appendix — Plan schema (Rust types)

```rust
// crates/hl-common/src/plan.rs
pub enum PerpTif { Gtc, Ioc, Alo }
pub enum Trigger { None, Tp{px:f64}, Sl{px:f64} }

pub struct PerpOrder {
  pub coin: String, pub side_bid: bool,
  pub px: Option<String>, // "mid-1%" | "1234.5"
  pub sz: f64, pub tif: PerpTif,
  pub reduce_only: bool, pub trigger: Trigger
}

pub enum Action {
  PerpOrders { orders: Vec<PerpOrder> },
  PerpCancel { scope: String },            // "all" | "last_oid" | "oids:[...]"
  UsdClassTransfer { to_perp: bool, usdc: f64 },
  SetLeverage { coin: String, leverage: u32 },
  SpotTransfer { token: String, amount: f64, to: String } // optional
}

pub struct Plan { pub steps: Vec<Action> }
```

---

## Final note

This spec is designed to **maximize prize odds with minimum code**:

* You ship a working **public good** that everyone needs *today* (Developer Tools).
* You show **monetization** in one flag (Builder Codes).
* You present a **credible path** to **Programmable Trading / HIP‑3** (dataset‑first hooks).
* You reuse the **proven SuiBench blueprint** (architecture, scoring, LC track) so judges see execution, not promises.&#x20;

If you want, I can now draft the **exact CLI**, **domains‑hl.yaml** starter, and a **single HiaN prompt + ground\_truth.json** so you can run the first end‑to‑end score within the next session.
