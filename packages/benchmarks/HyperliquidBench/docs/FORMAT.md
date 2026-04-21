Below is the **reference layout and example payloads** for an LLM‑driven run of **HyperLiquidBench**. This is exactly what your teammates (and the evaluator) should expect to read after a run.

> The structure mirrors the “generator → runner → evaluator” pipeline and the **Base + Bonus − Penalty** coverage math we used in SuiBench (only the unit changes from “MoveCall” to “venue action”).&#x20;

---

## 1) Folder layout for a single run

```
runs/2025-09-22-103015/                # one timestamped directory per run
├─ plan.json                            # normalized plan the runner executed (from LLM or file)
├─ plan_raw.txt                         # raw LLM text before normalization (if LLM used)
├─ per_action.jsonl                     # 1 line per submitted action + correlated effects (WS)
├─ ws_stream.jsonl                      # raw websocket frames (snapshots + deltas)
├─ orders_routed.csv                    # csv of orders actually routed (for quick sanity)
├─ run_meta.json                        # environment, network, model, hashes, etc.
├─ llm/                                 # (present only if LLM agent used)
│  ├─ request.json                      # full OpenRouter payload we sent
│  ├─ response.json                     # full OpenRouter JSON response
│  └─ raw.txt                           # assistant message content as-is (for debugging)
├─ eval_per_action.jsonl                # (evaluator output) normalized signatures per action
├─ eval_score.json                      # (evaluator output) Base/Bonus/Penalty and breakdown
└─ unique_signatures.json               # (evaluator output) sorted list of uniques
```

> This mirrors the “Step 4: run the test, get the score & report” and the high‑level architecture slide in the SuiBench deck.&#x20;

---

## 2) `plan.json` (normalized plan the runner executed)

**Purpose:** The canonical plan after any cleaning the runner applied (e.g., stripping code fences, normalizing enums, resolving `mid±%`).

```json
{
  "steps": [
    {
      "perp_orders": {
        "builderCode": "mybot_v1",
        "orders": [
          {
            "coin": "ETH",
            "tif": "ALO",
            "side": "buy",
            "sz": 0.01,
            "reduceOnly": false,
            "px": "mid-1%",
            "cloid": "a1f4e2a0-8d42-4e5e-9f80-3766d0e4caa8",
            "trigger": { "kind": "none" }
          }
        ]
      }
    },
    { "sleep_ms": { "duration_ms": 120 } },
    { "cancel_last": { "coin": "ETH" } },
    { "usd_class_transfer": { "to_perp": true, "usdc": 25.0 } },
    { "set_leverage": { "coin": "ETH", "leverage": 10, "cross": false } }
  ]
}
```

**Notes**

* `px` can be a number (`"px": 3521.25`) or `"mid±X%"` string; the runner resolves it at send time.

---

## 3) LLM artifacts (`llm/` folder)

These files make the run **reproducible and auditable** (don’t trust—verify the prompt, the model, and the exact output the plan was derived from).&#x20;

### 3.1 `llm/request.json` (OpenRouter payload)

```json
{
  "model": "openai/gpt-5-high",
  "response_format": { "type": "json_object" },
  "messages": [
    { "role": "system", "content": "You are a HyperLiquidBench planner. Output STRICT JSON..." },
    { "role": "user", "content": "{\"context\":{\"wallet\":\"0x...\",\"coins\":[\"ETH\",\"BTC\"]}}" }
  ],
  "temperature": 0.2,
  "top_p": 1.0,
  "max_tokens": 500
}
```

### 3.2 `llm/response.json` (OpenRouter response)

```json
{
  "id": "resp_01H...",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "{ \"steps\": [ { \"perp_orders\": { ... } }, { \"cancel_last\": {\"coin\":\"ETH\"} } ] }"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 756, "completion_tokens": 118, "total_tokens": 874 }
}
```

### 3.3 `plan_raw.txt`

````
Here is your plan:

```json
{ "steps": [ ... ] }
````

(…any extra prose left by the model…)

````

The runner strips fences/prose, validates, and writes the cleaned result to `plan.json`.

---

## 4) `per_action.jsonl` (one line per submitted action)

**Purpose:** The evaluator consumes this file. Each line is an `ActionLogRecord` (the exact Rust struct you implemented).

**Schema (per line):**
```ts
{
  stepIdx: number,
  action: "perp_orders" | "cancel_last" | "cancel_oids" | "cancel_all" | "usd_class_transfer" | "set_leverage",
  submitTsMs: number,              // unix ms
  windowKeyMs: number,             // floor(submitTsMs, per_action_window_ms)
  request: object,                 // normalized 'request' we sent (human-readable)
  ack?: object,                    // HTTP ack, normalized (status + statuses[])
  observed?: object | object[],    // first matching WS event(s) correlated by oid/ledger
  notes?: string                   // diagnostics (e.g., "no websocket confirmation for oids: …")
}
````

**Example lines (JSONL):**

```json
{"stepIdx":0,"action":"perp_orders","submitTsMs":1727005012145,"windowKeyMs":1727005012000,
 "request":{"perp_orders":{"orders":[{"coin":"ETH","side":"buy","sz":0.01,"tif":"ALO","reduceOnly":false,"px":"mid-1%","resolvedPx":3512.42}],"builderCode":"mybot_v1"}},
 "ack":{"status":"ok","data":{"statuses":[{"kind":"resting","oid":987654321}]}},
 "observed":[{"channel":"orderUpdates","coin":"ETH","oid":987654321,"status":"resting","sz":"0.01","limitPx":"3512.42"}]}
{"stepIdx":2,"action":"cancel_last","submitTsMs":1727005012309,"windowKeyMs":1727005012200,
 "request":{"cancel_last":{"coin":"ETH"}},
 "ack":{"status":"ok","data":{"statuses":[{"kind":"success"}]}},
 "observed":{"channel":"orderUpdates","oid":987654321,"status":"canceled"}}
{"stepIdx":3,"action":"usd_class_transfer","submitTsMs":1727005012403,"windowKeyMs":1727005012400,
 "request":{"usd_class_transfer":{"toPerp":true,"usdc":25.0}},
 "ack":{"status":"ok","data":{"statuses":[{"kind":"success"}]}},
 "observed":{"channel":"accountClassTransfer","time":1727005012420,"usdc":25.0,"toPerp":true}}
{"stepIdx":4,"action":"set_leverage","submitTsMs":1727005012495,"windowKeyMs":1727005012400,
 "request":{"set_leverage":{"coin":"ETH","leverage":10,"cross":false}},
 "ack":{"status":"ok","data":{"statuses":[{"kind":"success"}]}}}
```

**Key points**

* If the venue **rejects** the request (`ack.status != "ok"`), we still log the line, but the evaluator will no‑op it.
* `observed` is the WS confirmation (order update/fill, or ledger update). If missing before timeout, we put a `notes` string (the evaluator can still count the action by ack).

---

## 5) `ws_stream.jsonl` (raw Info WS frames)

**Purpose:** Full fidelity stream for debugging and cross‑checking evaluator logic.

**Example lines (JSONL):**

```json
{"channel":"orderUpdates","data":[{"coin":"ETH","oid":987654321,"side":"buy","limitPx":"3512.42","sz":"0.01","status":"resting","statusTimestamp":1727005012158}]}
{"channel":"userFills","isSnapshot":false,"fills":[{"oid":987654321,"coin":"ETH","px":"3512.42","sz":"0.01","time":1727005012191,"side":"buy"}]}
{"channel":"userNonFundingLedgerUpdates","isSnapshot":false,"updates":[{"channel":"accountClassTransfer","time":1727005012420,"usdc":25.0,"toPerp":true}]}
```

We also persist any **isSnapshot** frames verbatim.

---

## 6) `orders_routed.csv`

**Columns (header is written once):**

```
ts,oid,coin,side,px,sz,tif,reduceOnly,builderCode
```

**Example row:**

```
1727005012145,987654321,ETH,buy,3512.42,0.01,ALO,false,mybot_v1
```

---

## 7) `run_meta.json`

**Purpose:** Everything you need to re‑run or attribute the result.

```json
{
  "network": "testnet",
  "builderCode": "mybot_v1",
  "wallet": "0xabc123...def",
  "effectTimeoutMs": 2000,
  "timestamp": "2025-09-22-103015",
  "plan": { "stepsCount": 5 },           // light summary; the full plan is in plan.json
  "llm": {
    "provider": "openrouter",
    "model": "openai/gpt-5-pro",
    "requestId": "resp_01H...",
    "promptSha256": "f2e0…",
    "responseSha256": "a91b…",
    "usage": { "prompt": 756, "completion": 118, "total": 874 }
  }
}
```

---

## 8) Evaluator inputs & outputs

### 8.1 Input: `dataset/domains-hl.yaml`

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

### 8.2 Output: `eval_per_action.jsonl`

Per line, the evaluator writes the **normalized** view it scored:

```json
{"stepIdx":0,"action":"perp_orders","submitTsMs":1727005012145,"windowKeyMs":1727005012000,
 "signatures":["perp.order.ALO:false:none"],"ignored":false,"reason":null}
{"stepIdx":2,"action":"cancel_last","submitTsMs":1727005012309,"windowKeyMs":1727005012200,
 "signatures":["perp.cancel.last"],"ignored":false}
{"stepIdx":3,"action":"usd_class_transfer","submitTsMs":1727005012403,"windowKeyMs":1727005012400,
 "signatures":["account.usdClassTransfer.toPerp"],"ignored":false}
{"stepIdx":4,"action":"set_leverage","submitTsMs":1727005012495,"windowKeyMs":1727005012400,
 "signatures":["risk.setLeverage.ETH"],"ignored":false}
```

**How signatures are formed (coverage unit):**

* `perp.order.{TIF}:{reduceOnly}:{trigger}` → e.g., `perp.order.ALO:false:none`
* `perp.cancel.{last|oids|all}`
* `account.usdClassTransfer.{toPerp|fromPerp}`
* `risk.setLeverage.{COIN}`

> The per‑window composition bonus uses the same idea as PTB composition in SuiBench: group by `windowKeyMs` and add `+0.25 × max(0, distinct_in_window−1)`.&#x20;

### 8.3 Output: `eval_score.json`

```json
{
  "final_score": 3.75,
  "base": 3.0,
  "bonus": 0.75,
  "penalty": 0.0,
  "per_domain": [
    {
      "name": "perp",
      "weight": 1.0,
      "unique_signatures": ["perp.cancel.last", "perp.order.ALO:false:none"],
      "unique_count": 2,
      "contribution": 2.0
    },
    {
      "name": "account",
      "weight": 1.0,
      "unique_signatures": ["account.usdClassTransfer.toPerp"],
      "unique_count": 1,
      "contribution": 1.0
    },
    {
      "name": "risk",
      "weight": 1.0,
      "unique_signatures": ["risk.setLeverage.ETH"],
      "unique_count": 1,
      "contribution": 1.0
    }
  ],
  "unique_signatures": [
    "account.usdClassTransfer.toPerp",
    "perp.cancel.last",
    "perp.order.ALO:false:none",
    "risk.setLeverage.ETH"
  ],
  "cap_per_signature": 3,
  "window_ms": 200
}
```

### 8.4 Output: `unique_signatures.json`

```json
[
  "account.usdClassTransfer.toPerp",
  "perp.cancel.last",
  "perp.order.ALO:false:none",
  "risk.setLeverage.ETH"
]
```

---

## 9) CLI example (end‑to‑end)

```bash
# 1) Run with an LLM plan (OPENROUTER_API_KEY in env; HL_PRIVATE_KEY set)
hl-runner \
  --plan dataset/tasks/hl_llm_plans.jsonl:1 \
  --network testnet \
  --out runs/$(date +%Y%m%d-%H%M%S)

# 2) Score coverage
RUN_DIR=$(ls -dt runs/* | head -n1)
hl-evaluator \
  --input "$RUN_DIR/per_action.jsonl" \
  --domains dataset/domains-hl.yaml \
  --out-dir "$RUN_DIR"

# 3) Inspect
cat "$RUN_DIR/eval_score.json"
jq -C '.' "$RUN_DIR/llm/request.json" | head -100
jq -C '.' "$RUN_DIR/llm/response.json" | head -100
```

---

## 10) Data contract summary (what the evaluator assumes)

* **Timestamps** are millisecond UNIX epoch.
* **Windowing** uses `per_action_window_ms` from the YAML (default 200ms).
* **Acks** must include `status: "ok" | "err"`; if OK and a per‑order status exists, kinds include: `resting`, `success`, `filled`, `waitingForFill`, `waitingForTrigger`, `error`.
* **No‑op filter**: if `ack.status != "ok"` or there is no effectful status, the action contributes **0**.
* **Per‑signature cap**: repeats past the cap don’t increase Base; (optionally) they incur a small penalty per extra.
* **WS confirmations** are *not required* to score base/bonus, but missing confirmations should be visible in `notes` for operability debugging.

---

### Why this layout?

It lets you:

* **Reconstruct** the exact plan the model proposed (and how you normalized it).
* **Attribute** every score delta to an **ack** and a **WS effect**.
* **Audit** the prompt/response and token usage for the model (reproducibility).
* **Compare** across models with a single, stable `eval_score.json`.

The same principles powered SuiBench’s reproducible flow of declaring metrics, executing, and scoring; we retain that **don’t trust—verify** posture here.&#x20;

If you want, I can generate stub files with dummy data so your teammates can wire the evaluator before you run on testnet.
