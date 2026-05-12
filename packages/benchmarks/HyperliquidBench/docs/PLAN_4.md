Below is a **developer‑ready** spec for **PLAN\_4.md – “Domains & Dataset”** for **HyperLiquidBench**. It locks down formats, file names, schemas, examples, and acceptance tests so another engineer can implement exactly what’s written.

> **Design rationale.** Scoring follows the same principle as SuiBench — **FINAL\_SCORE = Base + Bonus − Penalty** — and uses a **no‑op/effect filter** so only meaningful actions count. See the “Coverage Scoring Details” slide (page 12) and “don’t trust, verify” motivation (pages 1–2) in the SuiBench deck.&#x20;

---

# PLAN\_4.md — Domains & Dataset (HyperLiquidBench)

## Scope

1. Define the **domains config** (`dataset/domains-hl.yaml`) used by the evaluator.
2. Define the **coverage task set** (`dataset/tasks/*.jsonl`) that the runner can execute deterministically.
3. Define the **HiaN (long‑context) case bundle** (`dataset/hian/**`) for pass/fail accuracy testing.
4. Provide **CLI recipes + acceptance tests** to validate the pipeline end‑to‑end.

---

## 4.1 `dataset/domains-hl.yaml` (authoritative scoring config)

### 4.1.1 File path

```
dataset/
└── domains-hl.yaml
```

### 4.1.2 YAML schema (normative)

```yaml
version: "0.1"

# Window (ms) for composition bonus: all distinct signatures whose
# ActionLogRecord.windowKeyMs are equal are considered "composed".
per_action_window_ms: 200

# Max times a single signature may contribute to base score across the run.
# Repeats beyond this cap incur a penalty.
per_signature_cap: 3

domains:
  <domain-name>:
    weight: <float>            # multiplier applied to the number of unique signatures in this domain
    allow:                     # list of dot‑separated patterns with '*' wildcards (segment level)
      - "<pattern>"
      - "<pattern>"
  ...
```

**Pattern grammar (dot‑segments)**

* `Literal` segment: exact, case‑sensitive match (e.g., `perp`, `order`, `GTC:false:none`).
* `*` segment: matches **any single** segment.
* The number of segments in a pattern **must equal** the number in the signature.

**Scoring defaults**

* `per_action_window_ms` defaults to 200 if omitted.
* `per_signature_cap` defaults to 3 if omitted.

### 4.1.3 Signature grammar (produced by the evaluator’s normalizer)

These are the only signatures v0.1 emits; every new action we add must define its signature mapping here.

| Action family       | Signature format (dot separated)          | Notes                                                                                                                   |                                       |                                                          |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| Perp limit orders   | `perp.order.{TIF}:{reduceOnly}:{trigger}` | `TIF ∈ {ALO,GTC,IOC}` (upper‑case). `reduceOnly ∈ {true,false}`. `trigger ∈ {none,tp,sl,...}` (v0.1 emits `none` only). |                                       |                                                          |
| Cancels             | \`perp.cancel.{last                       | oids                                                                                                                    | all}\`                                | Derived from `cancel_last`, `cancel_oids`, `cancel_all`. |
| USDC class transfer | \`account.usdClassTransfer.{toPerp        | fromPerp}\`                                                                                                             | Direction taken from request payload. |                                                          |
| Leverage            | `risk.setLeverage.{COIN}`                 | `COIN` is literal (e.g., `ETH`).                                                                                        |                                       |                                                          |

> Effect filter: only actions with **ack.status == "ok"** and **non‑error** statuses are counted; otherwise the record is **ignored**. This implements the “no‑op filter” idea from the SuiBench method.&#x20;

### 4.1.4 Reference config (drop‑in)

```yaml
version: "0.1"
per_action_window_ms: 200
per_signature_cap: 3

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

> This matches the evaluator you’ve written (pattern semantics, windowing, cap). Keep this file under git; changes to it should be considered a **scoring version bump**.

---

## 4.2 Coverage tasks (runner‑ready plans)

Coverage tasks are **JSONL** files where **each line is a complete plan** object the runner can execute. The evaluator **does not** read these; the runner does. The evaluator consumes only the run artifacts (e.g., `per_action.jsonl`) the runner produces.

### 4.2.1 File paths

```
dataset/
└── tasks/
    ├── hl_perp_basic_01.jsonl
    ├── hl_cancel_sweep_01.jsonl
    ├── hl_risk_and_account_01.jsonl
    └── README.md
```

### 4.2.2 Plan JSON schema (must match `hl-common::plan`)

Top level:

```json
{
  "steps": [ ActionStep, ... ]
}
```

`ActionStep` is **untagged** (exactly like your `ActionStep` enum):

* `{"perp_orders": { "orders": [PerpOrder, ...], "builderCode": "optional-override" }}`
* `{"cancel_last": { "coin": "optional-coin" }}`
* `{"cancel_oids": { "coin": "ETH", "oids": [123,456] }}`
* `{"cancel_all": { "coin": "optional-coin" }}`
* `{"usd_class_transfer": { "toPerp": true, "usdc": 10.5 }}`
* `{"set_leverage": { "coin": "ETH", "leverage": 5, "cross": false }}`
* `{"sleep_ms": { "durationMs": 250 }}`

`PerpOrder`:

```json
{
  "coin": "ETH",
  "tif": "Gtc",             // Alo | Gtc | Ioc  (case‑insensitive; runner uppercases)
  "side": "buy",            // buy | sell
  "sz": 0.01,
  "reduceOnly": false,
  "builderCode": "optional",
  "cloid": "optional-uuid",
  "trigger": { "kind": "none" },
  "px":  "mid-1.0%"         // or number (absolute); "mid±X%"
}
```

> The runner converts `"px": "mid-1.0%"` using live mid from `InfoClient`; your implementation already handles this via `OrderPrice::MidPercent`.

### 4.2.3 Starter tasks (copy‑paste)

**`dataset/tasks/hl_perp_basic_01.jsonl`**

```json
{"steps":[
  {"perp_orders":{"orders":[
    {"coin":"ETH","tif":"Alo","side":"buy","sz":0.01,"reduceOnly":false,"px":"mid-1.0%"},
    {"coin":"ETH","tif":"Gtc","side":"sell","sz":0.01,"reduceOnly":false,"px":"mid+1.0%"}
  ]}},
  {"cancel_last":{}}
]}
```

**`dataset/tasks/hl_cancel_sweep_01.jsonl`**

```json
{"steps":[
  {"perp_orders":{"orders":[
    {"coin":"ETH","tif":"Gtc","side":"buy","sz":0.02,"reduceOnly":false,"px":"mid-0.5%"}
  ]}},
  {"sleep_ms":{"durationMs":150}},
  {"cancel_all":{"coin":"ETH"}}
]}
```

**`dataset/tasks/hl_risk_and_account_01.jsonl`**

```json
{"steps":[
  {"usd_class_transfer":{"toPerp":true,"usdc":10.0}},
  {"set_leverage":{"coin":"ETH","leverage":5,"cross":false}},
  {"perp_orders":{"orders":[
    {"coin":"ETH","tif":"Ioc","side":"buy","sz":0.01,"reduceOnly":true,"px":"mid"}
  ]}}
]}
```

> These three lines already produce multiple distinct signatures and exercise **window bonus** (200ms). To reliably get bonus for step combinations, keep consecutive actions close in time, or insert short `sleep_ms` values if you want to **avoid** coalescing.

### 4.2.4 Runner commands (deterministic runs)

```bash
# 1) Pick a task line, run it, produce artifacts under runs/<ts>/
export HL_PRIVATE_KEY=0x<your_test_key>
cargo run -p hl-runner -- \
  --plan dataset/tasks/hl_perp_basic_01.jsonl:1 \
  --network testnet

# 2) Evaluate using the domains config (writes eval_*.json next to per_action.jsonl)
RUN_DIR=$(ls -dt runs/* | head -n1)
cargo run -p hl-evaluator -- \
  --input "$RUN_DIR/per_action.jsonl" \
  --domains dataset/domains-hl.yaml
cat "$RUN_DIR/eval_score.json"
```

**Acceptance (expected)**

* `eval_per_action.jsonl` contains normalized `signatures` for each step.
* `eval_score.json` exposes `{ finalScore, base, bonus, penalty, perDomain[], unique_signatures[] }`.

---

## 4.3 HiaN (Long‑Context “Needle”) cases

HiaN cases test **accuracy under noise** (Pass/Fail) rather than breadth. The idea mirrors SuiBench’s LC track (page 10).&#x20;

### 4.3.1 File layout

```
dataset/hian/case_128k/
├── prompt.txt            # giant noisy context containing the needle + keys
├── ground_truth.json     # exact effects we require
└── meta.json             # reproducibility metadata
```

You can create multiple cases: `case_128k/`, `case_512k/`, `case_1m/` and variants `pos_05/`, `pos_50/`, `pos_95/` to vary **needle position**.

### 4.3.2 `prompt.txt` content contract

* The **needle instruction** is a single **highest‑priority** directive such as:
  “**Send 7.5 USDC from spot to perps, then place an ALO bid mid-1% on ETH for 0.01**”
* The **keys** (exact parameters) **must also be present** in the context, potentially far away (e.g., target asset, size, direction).
* Everything else is **noise**: orderbook logs, unrelated docs, chats, etc.

### 4.3.3 `ground_truth.json` schema (minimal v0.1)

```json
{
  "require": [
    {"signature":"account.usdClassTransfer.toPerp"},
    {"signature":"perp.order.ALO:false:none"}
  ],
  "optional": [
    {"signature":"perp.cancel.*"}          // if the instruction asks to cancel, put it in require
  ]
}
```

* The evaluator’s HiaN checker (added in step 5) will **scan `per_action.jsonl`** for ack‑OK actions and assert that every `require[*].signature` (wildcards allowed) **appears at least once**.
* If any `require` is missing → **Fail**; otherwise **Pass**.
* Store the final result in `runs/<ts>/eval_hian.json`:

  ```json
  { "passed": true, "missing": [] }
  ```

---

## 4.4 Scoring rules (binding)

> Mirrors the SuiBench scoring idea: **Base** (weighted unique signatures) + **Bonus** (composition inside a time window) − **Penalty** (spam beyond cap). See the “Coverage Scoring Details” page.&#x20;

* **Base**
  For each domain `d`:
  `base += domain.weight * unique_signatures(d)`
  Uniqueness is computed **after** mapping each action to its signature string.

* **Bonus (composition)**
  For each `windowKeyMs` bucket (equal window start), let `k = distinct_signatures_in_bucket`.
  `bonus += 0.25 * max(0, k - 1)`.

* **Penalty (spam)**
  Maintain a count per signature across the entire run. If a signature occurs `> per_signature_cap`, for each extra occurrence add:
  `penalty += 0.1`.

* **Final score**
  `FINAL_SCORE = base + bonus − penalty`.

* **Effect/no‑op filter**
  Any action with `ack.status != "ok"` or with an acknowledged **error** is ignored for both base and bonus. (Already implemented in your normalizer.)

---

## 4.5 Developer checklist

* [x] Create `dataset/domains-hl.yaml` with the **reference config** above.
* [x] Create `dataset/tasks/` and add **three starter JSONL** files from §4.2.3.
* [x] Add `dataset/hian/case_128k/` and stub **prompt.txt**, **ground\_truth.json**, **meta.json** (fill with placeholders now).
* [x] Add `dataset/tasks/README.md` that explains how to select a JSONL line with `:N`.
* [x] Ensure CI caches the dataset directory, and publishes `runs/<ts>/eval_*` as artifacts.

---

## 4.6 QA / Acceptance tests

1. **Smoke (coverage):**

   ```bash
   export HL_PRIVATE_KEY=0x<key>
   cargo run -p hl-runner -- --plan dataset/tasks/hl_perp_basic_01.jsonl:1 --network testnet
   RUN_DIR=$(ls -dt runs/* | head -n1)
   cargo run -p hl-evaluator -- --input "$RUN_DIR/per_action.jsonl" --domains dataset/domains-hl.yaml
   cat "$RUN_DIR/eval_per_action.jsonl" | head
   cat "$RUN_DIR/eval_score.json"
   ```

   **Expect:**

    * At least these signatures appear once:
      `perp.order.ALO:false:none`, `perp.order.GTC:false:none`, `perp.cancel.last`.
    * `bonus >= 0.25` (two distinct orders land in the same 200ms window if they were acked close enough; if not, insert a small `sleep_ms` to control it).

2. **Spam/penalty:** Run a plan that repeats `perp.order.GTC:false:none` 5–6 times in quick succession; verify `penalty` increases by `0.1` per extra beyond the cap (3).

3. **Cap/uniques:** Ensure repeating the **same** signature more than `cap` **does not** increase `unique_signatures` count, only the penalty.

4. **HiaN (placeholder):**

    * Put in `ground_truth.json` the two `require` signatures shown in §4.3.3.
    * Run an `llm_hian` agent (step 5) that reads `prompt.txt` and generates a plan.
    * Manually verify pass/fail by inspecting `eval_per_action.jsonl`.
    * In step 5, add a small HiaN checker to produce `eval_hian.json`.

---

## 4.7 Maintenance & versioning

* Any change to signature grammar or pattern semantics requires a **domains version bump** (`version: "0.2"`), and a corresponding tag in the repo.
* Keep **dataset/** deterministic and under git. When prompts are too large, store a SHA256 in `meta.json` and host the blob externally — still track the hash for reproducibility (as recommended in the SuiBench doc’s workflow pages 11–13).&#x20;

---

## 4.8 Appendix — Worked example of normalization

**Input line (`per_action.jsonl`)**

```json
{
  "stepIdx": 0,
  "action": "perp_orders",
  "submitTsMs": 1711111111111,
  "windowKeyMs": 1711111111000,
  "request": {"perp_orders":{"orders":[
    {"coin":"ETH","tif":"Gtc","side":"buy","sz":0.01,"reduceOnly":false,"px":"mid-1%"}
  ]}},
  "ack": {"status":"ok","data":{"statuses":[{"kind":"resting","oid":12345}]}},
  "observed": [{"channel":"orderUpdates","oid":12345,"status":"resting"}]
}
```

**Evaluator emits**
`signatures = ["perp.order.GTC:false:none"]`, `ignored=false`.

That signature matches `domains.perp.allow = ["perp.order.*"]` → contributes `+1.0` to `base`.

---

**That’s it.** With this document, another developer can: create the YAML, seed three tasks, run the runner, and compute consistent scores with the evaluator you’ve built, while keeping room for the HiaN track in step 5 (pass/fail).
