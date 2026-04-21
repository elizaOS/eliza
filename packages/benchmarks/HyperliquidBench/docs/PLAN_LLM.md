Below is a drop‑in **DETAILED\_PLAN\_LLM.md** for HyperLiquidBench.
It specifies *what to build*, *how to wire it*, *exact prompts*, *payload schemas*, and *robust parsing* so another developer can implement it 1:1 in Rust.

---

# DETAILED\_PLAN\_LLM.md — LLM Plan Generation & Execution for **HyperLiquidBench**

> Goal: let the runner **ask an LLM** (via OpenRouter) for a short, machine‑readable trading plan and **execute** it against Hyperliquid (testnet/local), logging artifacts that the evaluator can score.
> Non‑goals: strategy alpha, real‑money trading, unsupported order types (triggers can be stubbed for now).

---

## 0) High‑level architecture

```
hl-runner
 ├─ detect plan spec:
 │    ├─ file.json / file.jsonl:N  → load_plan_from_spec (already implemented)
 │    └─ "llm:coverage"            → call LLM (coverage prompt) → Plan JSON
 │       "llm:hian:<path>"         → load long context from <path> → call LLM (HiaN prompt) → Plan JSON
 │
 ├─ persist artifacts:
 │    runs/<ts>/{plan.json, plan_raw.txt, per_action.jsonl, ws_stream.jsonl, orders_routed.csv, run_meta.json}
 │
 └─ execute_plan(Plan) → (already implemented: posts orders, waits for WS acks, logs)
```

---

## 1) CLI & config surface

**New CLI flags (hl-runner):**

* `--plan llm:coverage`
  Generate a short coverage plan via LLM.
* `--plan llm:hian:<FILE>`
  Generate a plan from a long‑context **HiaN** file.
* `--llm-model <id>` (env: `LLM_MODEL`)
  e.g., `openai/gpt-5`, `google/gemini-2.5-pro` (use any OpenRouter model your key can access).
* `--llm-max-steps <n>` (default `5`)
  Upper bound we instruct the model to respect.
* `--llm-allowed-coins <CSV>` (optional)
  Comma‑separated allowlist, e.g., `BTC,ETH,SOL`. If omitted, pass the top‑N from InfoClient `all_mids()`.
* `--llm-builder-code <code>` (optional)
  Default builder code to recommend in the prompt; step‑level `builderCode` still overrides.
* `--llm-temperature <f64>` (default `0.2`)
* `--llm-top-p <f64>` (default `1.0`)
* `--llm-max-output-tokens <u32>` (default `800`)

**Environment variables:**

* `OPENROUTER_API_KEY` (required)
* `LLM_MODEL` (if not provided via CLI)
* `HL_LLM_CACHE_DIR` (optional) — directory to cache prompt → response (for reproducibility)
* `HL_LLM_DRYRUN=1` (optional) — generate plan but **don’t** send to exchange; still write artifacts.

---

## 2) Plan JSON schema (must match `hl-common`)

We reuse the existing types you implemented:

```jsonc
{
  "steps": [
    { "perp_orders": {
        "orders": [
          {
            "coin": "ETH",
            "tif": "GTC" | "ALO" | "IOC",
            "side": "buy" | "sell",
            "sz": 0.01,
            "reduceOnly": false,
            "builderCode": "myapp",       // optional
            "cloid": "UUID-v4",           // optional
            "trigger": { "kind": "none" },// currently only "none" is supported
            "px":  3500.5                 // or string: "mid+0.25%" / "mid-0.5%"
          }
        ],
        "builderCode": "default-code"     // optional; used when order-level is absent
    }},

    { "cancel_last": { "coin": "ETH" } },          // coin optional (last overall if omitted)
    { "cancel_oids": { "coin": "BTC", "oids": [1] }},
    { "cancel_all":  { "coin": "ETH" } },          // coin optional (all coins if omitted)
    { "usd_class_transfer": { "toPerp": true, "usdc": 12.5 } },
    { "set_leverage": { "coin": "ETH", "leverage": 5, "cross": false } },
    { "sleep_ms": { "durationMs": 200 } }
  ]
}
```

> This schema is **exactly** what your `hl-common` parser understands today.

---

## 3) Implementation plan (code‑level)

### 3.1 Add an LLM module to the runner

**Files to add:**

```
crates/hl-runner/src/llm/mod.rs
crates/hl-runner/src/llm/openrouter.rs
crates/hl-runner/src/llm/plan_decode.rs
crates/hl-runner/src/llm/prompts.rs
```

#### `openrouter.rs` — HTTP client

```rust
use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};

pub struct OpenRouter {
    client: Client,
    endpoint: String,
    api_key: String,
    model: String,
    temperature: f32,
    top_p: f32,
    max_tokens: u32,
    title: String,
}

impl OpenRouter {
    pub fn new(
        api_key: String,
        model: String,
        temperature: f32,
        top_p: f32,
        max_tokens: u32,
        title: String,
    ) -> Result<Self> {
        Ok(Self {
            client: Client::builder().build()?,
            endpoint: "https://openrouter.ai/api/v1/chat/completions".to_string(),
            api_key,
            model,
            temperature,
            top_p,
            max_tokens,
            title,
        })
    }

    pub async fn chat_json(&self, system: &str, user: &str) -> Result<String> {
        let body = json!({
          "model": self.model,
          "temperature": self.temperature,
          "top_p": self.top_p,
          "max_tokens": self.max_tokens,
          "response_format": { "type": "json_object" },
          "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
          ]
        });

        let resp = self.client
          .post(&self.endpoint)
          .header("Authorization", format!("Bearer {}", self.api_key))
          .header("X-Title", &self.title)      // OpenRouter requires Referer or Title
          .json(&body)
          .send()
          .await
          .context("openrouter: HTTP error")?;

        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(anyhow!("openrouter {}: {}", status, text));
        }

        Ok(text) // raw JSON string; let decoder inspect it
    }
}
```

#### `plan_decode.rs` — tolerant response → `Plan`

Robustly handle the typical failure modes: code fences, arrays of steps, extra prose.

````rust
use anyhow::{anyhow, Context, Result};
use hl_common::plan::{Plan, ActionStep};
use serde_json::Value;

pub fn strip_fences(s: &str) -> &str {
    let s = s.trim();
    if s.starts_with("```") {
        let s = s.trim_start_matches("```json")
                 .trim_start_matches("```JSON")
                 .trim_start_matches("```");
        return s.trim_end_matches("```").trim();
    }
    s
}

pub fn decode_llm_body(raw_body: &str) -> Result<(Plan, String)> {
    // The OpenRouter body itself is JSON: { choices: [ { message: { content: "..." } } ] }
    let v: Value = serde_json::from_str(raw_body)
        .context("openrouter: body is not JSON")?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| anyhow!("openrouter: missing content"))?;
    let raw_content = content.to_string();

    // Try strict first
    decode_plan_from_content(content).or_else(|_| {
        // Try after stripping fences
        decode_plan_from_content(strip_fences(content))
    }).or_else(|_| {
        // If it's an array of steps, wrap it
        let s = strip_fences(content);
        if let Ok(steps) = serde_json::from_str::<Vec<ActionStep>>(s) {
            Ok( (Plan { steps }, raw_content) )
        } else {
            Err(anyhow!("failed to parse LLM plan"))
        }
    })
}

fn decode_plan_from_content(s: &str) -> Result<(Plan, String)> {
    let plan: Plan = serde_json::from_str(s)
        .context("content not a Plan object")?;
    Ok((plan, s.to_string()))
}
````

#### `prompts.rs` — canonical prompts

**Coverage prompt** (short planning):

```rust
pub fn coverage_system(max_steps: usize) -> String {
    format!(r#"
You are HyperLiquidBench Planner. Produce a STRICT JSON object (no prose) that
describes a short sequence of trading actions for Hyperliquid testnet/local.

HARD RULES:
- Use at most {max_steps} steps.
- Use ONLY these step shapes (camelCase keys):
  1) {{ "perp_orders": {{ "orders": [ {{ "coin": <SYMBOL>, "side": "buy"|"sell",
        "sz": <f64>, "tif": "GTC"|"ALO"|"IOC", "reduceOnly": <bool>,
        "px": <number| "mid+X%" | "mid-X%">,
        "builderCode": <string, optional>,
        "cloid": <uuid, optional>,
        "trigger": {{ "kind": "none" }} }} ], "builderCode": <string, optional> }} }}
  2) {{ "cancel_last": {{ "coin": <SYMBOL, optional> }} }}
  3) {{ "cancel_oids": {{ "coin": <SYMBOL>, "oids": [<u64>...] }} }}
  4) {{ "cancel_all":  {{ "coin": <SYMBOL, optional> }} }}
  5) {{ "usd_class_transfer": {{ "toPerp": <bool>, "usdc": <f64> }} }}
  6) {{ "set_leverage": {{ "coin": <SYMBOL>, "leverage": <u32>, "cross": <bool> }} }}
  7) {{ "sleep_ms": {{ "durationMs": <u64> }} }}

CONSTRAINTS:
- Only use coins from `allowedCoins` the user provides.
- `trigger.kind` must be "none" (trigger orders unsupported).
- Prefer maker behavior (GTC/ALO) for coverage runs.
- Return **valid JSON only** (no code fences, no commentary).
"#)
}

pub fn coverage_user(context_json: &serde_json::Value) -> String {
    // stringify the JSON context (allowedCoins, wallet, network, builderCode hint, examples)
    serde_json::to_string_pretty(context_json).unwrap()
}
```

**HiaN prompt** (long noisy context → one actionable step):

```rust
pub fn hian_system() -> &'static str {
    r#"
You are a HyperLiquid operational agent. Read the entire long context and locate
the SINGLE, highest-priority instruction that must be executed now.
Output EXACTLY ONE valid plan in strict JSON (no prose) with at most one step.
Allowed step kinds are the same as coverage; prefer a single `perp_orders` or `cancel_*`.
Do not guess IDs or symbols: use only values present in the context snippet.
Return valid JSON ONLY.
"#
}
```

#### `mod.rs` — orchestration

```rust
use anyhow::Result;
use serde_json::json;
use crate::llm::{openrouter::OpenRouter, plan_decode::decode_llm_body, prompts};

pub struct LlmCtx<'a> {
    pub base_url: &'a str,
    pub wallet_hex: String,
    pub allowed_coins: Vec<String>,
    pub default_builder: Option<String>,
    pub max_steps: usize,
    pub model: String,
    pub api_key: String,
    pub temperature: f32,
    pub top_p: f32,
    pub max_tokens: u32,
}

pub async fn gen_plan_coverage(ctx: &LlmCtx) -> Result<(hl_common::plan::Plan, String)> {
    let sys = prompts::coverage_system(ctx.max_steps);
    let user_payload = json!({
        "network": ctx.base_url,
        "wallet": format!("0x{}", ctx.wallet_hex.trim_start_matches("0x")),
        "allowedCoins": ctx.allowed_coins,
        "builderCodeHint": ctx.default_builder,
        "notes": "Return JSON only. Prefer maker-style perp orders, small sz like 0.01."
    });

    let client = OpenRouter::new(
        ctx.api_key.clone(),
        ctx.model.clone(),
        ctx.temperature,
        ctx.top_p,
        ctx.max_tokens,
        "HyperLiquidBench".to_string(),
    )?;
    let raw = client.chat_json(&sys, &prompts::coverage_user(&user_payload)).await?;
    let (plan, raw_content) = crate::llm::plan_decode::decode_llm_body(&raw)?;
    Ok((plan, raw_content))
}

pub async fn gen_plan_hian(ctx: &LlmCtx, long_context: &str) -> Result<(hl_common::plan::Plan, String)> {
    let client = OpenRouter::new(
        ctx.api_key.clone(), ctx.model.clone(),
        ctx.temperature, ctx.top_p, ctx.max_tokens,
        "HyperLiquidBench-HiaN".to_string(),
    )?;
    let raw = client.chat_json(prompts::hian_system(), long_context).await?;
    let (plan, raw_content) = crate::llm::plan_decode::decode_llm_body(&raw)?;
    Ok((plan, raw_content))
}
```

### 3.2 Wire into `hl-runner` main

* Detect **LLM plan spec** in `--plan`:

```rust
// crates/hl-runner/src/main.rs (inside main, before load_plan_from_spec)
let plan_spec = cli.plan.clone();
let plan: Plan;
let mut plan_raw: Option<String> = None;

if plan_spec.starts_with("llm:coverage") || plan_spec.starts_with("llm:hian:") {
    // build ctx
    let allowed = if let Some(csv) = &cli.llm_allowed_coins {
        csv.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    } else {
        // fallback: fetch top coins from InfoClient::all_mids()
        // (already creating info clients later; create a temporary one here or reuse)
        vec!["BTC".to_string(), "ETH".to_string()]
    };

    let llm_ctx = llm::LlmCtx {
        base_url: cli.network.as_str(),
        wallet_hex: format!("{:x}", wallet_address),
        allowed_coins: allowed,
        default_builder: cli.builder_code.clone(),
        max_steps: cli.llm_max_steps.unwrap_or(5),
        model: cli.llm_model.clone().unwrap_or_else(|| std::env::var("LLM_MODEL").unwrap_or_else(|_| "openai/gpt-5".to_string())),
        api_key: std::env::var("OPENROUTER_API_KEY").expect("OPENROUTER_API_KEY not set"),
        temperature: cli.llm_temperature.unwrap_or(0.2) as f32,
        top_p: cli.llm_top_p.unwrap_or(1.0) as f32,
        max_tokens: cli.llm_max_output_tokens.unwrap_or(800),
    };

    if plan_spec.starts_with("llm:coverage") {
        let (p, raw) = llm::gen_plan_coverage(&llm_ctx).await?;
        plan = p; plan_raw = Some(raw);
    } else {
        let path = plan_spec.trim_start_matches("llm:hian:").to_string();
        let ctx_text = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read HiaN context {}", path))?;
        let (p, raw) = llm::gen_plan_hian(&llm_ctx, &ctx_text).await?;
        plan = p; plan_raw = Some(raw);
    }
} else {
    plan = hl_common::load_plan_from_spec(&plan_spec)?;
}
```

* Pass `plan_raw` into `RunArtifacts::create(&out_dir, &plan.as_json(), plan_raw.as_deref(), …)` — your `hl-common` already supports this.

* If `HL_LLM_CACHE_DIR` is set, hash `(model + system + user)` and cache the raw OpenRouter body to disk; reuse if present (optional).

### 3.3 Reproducibility & guardrails

* Force **low temperature** (`0.2`), no streaming, and **response\_format: json\_object**.
* **Reject** any unsupported field (`trigger.kind != "none"`), or fix‑up by map → `{"kind":"none"}` and add a note in `ActionLogRecord.notes`.
* **Fail fast** if:

    * step count > `--llm-max-steps`
    * coin ∉ `allowed_coins`
    * sz ≤ 0 or absurd (e.g., > 1000) — configurable clamp
* If `HL_LLM_DRYRUN=1`, **skip** ExchangeClient calls but still produce `per_action.jsonl` entries with `ack.status = "skipped"`.

---

## 4) Prompts — full text you can paste

### 4.1 Coverage (short plan)

**System:**

```
You are HyperLiquidBench Planner. Produce a STRICT JSON object (no prose) that
describes a short sequence of trading actions for Hyperliquid testnet/local.

HARD RULES:
- Use at most {{MAX_STEPS}} steps.
- Use ONLY these step shapes (camelCase keys):
  { "perp_orders": { "orders": [ { "coin": <SYMBOL>,
                                   "side": "buy"|"sell",
                                   "sz": <f64>,
                                   "tif": "GTC"|"ALO"|"IOC",
                                   "reduceOnly": <bool>,
                                   "px": <number | "mid+X%" | "mid-X%">,
                                   "builderCode": <string, optional>,
                                   "cloid": <uuid, optional>,
                                   "trigger": { "kind": "none" } }... ],
                        "builderCode": <string, optional> } }
  { "cancel_last": { "coin": <SYMBOL, optional> } }
  { "cancel_oids": { "coin": <SYMBOL>, "oids": [<u64>...] } }
  { "cancel_all":  { "coin": <SYMBOL, optional> } }
  { "usd_class_transfer": { "toPerp": <bool>, "usdc": <f64> } }
  { "set_leverage": { "coin": <SYMBOL>, "leverage": <u32>, "cross": <bool> } }
  { "sleep_ms": { "durationMs": <u64> } }

CONSTRAINTS:
- Only use coins from `allowedCoins` (exact uppercase strings).
- `trigger.kind` must be "none".
- Prefer maker behavior (GTC or ALO).
- Return valid JSON only (no code fences, no commentary).
```

**User (JSON string):**

```json
{
  "network": "{{network}}",
  "wallet": "{{0x...}}",
  "allowedCoins": ["BTC","ETH","SOL"],
  "builderCodeHint": "myapp",
  "notes": "Cover diverse tif/side/reduceOnly combinations; small sz (<=0.02)."
}
```

### 4.2 HiaN (long context)

**System:**

```
You are a HyperLiquid operational agent. Read the entire long context and locate
the SINGLE, highest-priority instruction that must be executed now.

Output EXACTLY ONE plan in strict JSON (no prose) with at most one step.
Allowed step kinds are:
- perp_orders (one order is enough),
- cancel_last / cancel_oids / cancel_all,
- usd_class_transfer,
- set_leverage.

Do not guess IDs or symbols: use only values present in the context.
Return valid JSON ONLY.
```

**User:** contents of the supplied long text file.

---

## 5) Example: call & run

```bash
# 1) Env
export OPENROUTER_API_KEY=sk-or-...
export LLM_MODEL="google/gemini-2.5-pro"   # or any you have access to

# 2) Coverage, 3 steps max, ETH/BTC only
cargo run -p hl-runner -- \
  --plan llm:coverage \
  --network testnet \
  --private-key $HL_PRIVATE_KEY \
  --llm-model "$LLM_MODEL" \
  --llm-max-steps 3 \
  --llm-allowed-coins BTC,ETH \
  --builder-code myapp \
  --effect-timeout-ms 2000

# 3) HiaN (long context file)
cargo run -p hl-runner -- \
  --plan llm:hian:dataset/hian/ctx_128k.txt \
  --network testnet \
  --private-key $HL_PRIVATE_KEY \
  --llm-model "$LLM_MODEL" \
  --effect-timeout-ms 3000
```

Artifacts written under `runs/<timestamp>/` will include:

* `plan.json` (normalized machine plan)
* `plan_raw.txt` (the raw LLM content)
* `per_action.jsonl` / `orders_routed.csv` / `ws_stream.jsonl` (already implemented)
* `run_meta.json`

Then score:

```bash
cargo run -p hl-evaluator -- \
  --input runs/<ts>/per_action.jsonl \
  --domains dataset/domains-hl.yaml
cat runs/<ts>/eval_score.json
```

---

## 6) Batch runner for multiple models (optional)

`scripts/batch_llm.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

MODELS=("openai/gpt-5" "google/gemini-2.5-pro" "anthropic/claude-3.7-sonnet")
OUT="runs/llm_scores.csv"
echo "model,run_dir,score" > "$OUT"

for M in "${MODELS[@]}"; do
  export LLM_MODEL="$M"
  cargo run -p hl-runner -- \
    --plan llm:coverage \
    --network testnet \
    --private-key "$HL_PRIVATE_KEY" \
    --llm-allowed-coins BTC,ETH,SOL \
    --llm-max-steps 4 \
    --effect-timeout-ms 2000

  RUN_DIR=$(ls -dt runs/* | head -n1)
  cargo run -p hl-evaluator -- \
    --input "$RUN_DIR/per_action.jsonl" \
    --domains dataset/domains-hl.yaml

  S=$(jq -r '.final_score' "$RUN_DIR/eval_score.json")
  echo "$M,$RUN_DIR,$S" >> "$OUT"
done
echo "saved to $OUT"
```

---

## 7) Edge cases & hardening

* **OpenRouter 400**: include `X-Title`, ensure `Authorization` header present, model id spelled correctly.
* **Non‑JSON content**: we log raw body, try `strip_fences`, then try `Vec<ActionStep>`.
* **Unsafe outputs**:

    * coin not allowed → reject with error to user (do not auto‑substitute silently).
    * `trigger.kind != "none"` → replace with `none` and add `notes` in `ActionLogRecord`.
* **Reproducibility**:

    * Optional deterministic cache: hash `(model, system, user, temperature)`; if cache hit, skip API.
    * Log `LLM_MODEL`, `temperature`, `top_p`, and `hash(system+user)` in `run_meta.json`.

---

## 8) Unit tests to add

* `plan_decode.rs`

    * parses pure JSON, fenced JSON, and `[ {step}, ... ]`
    * fails on non‑JSON and returns helpful error
* `openrouter.rs`

    * mocked HTTP server returns minimal `choices[0].message.content`
* prompt smoke:

    * render `coverage_system()` with different `max_steps` and ensure step names are present.

---

## 9) Security & run mode

* Default to **testnet** or **local**; never mainnet by default.
* Clamp order size (e.g., `0.0001 ≤ sz ≤ 1`) and leverage (e.g., `1..=20`) with clear error messages.
* Provide `HL_LLM_DRYRUN=1` for demo/prompt work without touching the exchange.

---

## 10) Acceptance criteria

1. `--plan llm:coverage` produces `plan.json` and `plan_raw.txt` and executes without panics.
2. Invalid LLM output → informative error, with raw content logged; runner exits gracefully.
3. Evaluator recognizes actions and computes a non‑zero score when the LLM uses at least two distinct `perp.order.*` signatures within the same window.
4. HiaN mode executes exactly one effectful step if the context clearly contains one actionable instruction.

---

**That’s it.** This plan adds LLM plan generation with minimal surface area changes, strong guardrails, and first‑class artifacts for scoring and reproducibility.
