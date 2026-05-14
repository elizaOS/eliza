# Eliza-1 Pipeline — Contracts & Decisions

Wave 0 deliverable for jobs **W0-X1** (contracts + version scheme) and **W0-X4**
(sub-agent capture strategy). Companion to
[01-current-state.md](01-current-state.md), [02-gap-analysis.md](02-gap-analysis.md),
and [03-implementation-plan.md](03-implementation-plan.md).

This is a decision/contract doc. No implementation lives here. Each section
below is a contract that downstream W1+ jobs must respect.

---

## 1. Training format versioning

**Decision.** Commit to `eliza_native_v1` as the only supported training format
for the foreseeable future. Do not introduce `v2` opportunistically — it must be
justified by a concrete model-training requirement that v1 cannot satisfy.

### What `eliza_native_v1` is

The on-disk JSONL produced by
`eliza/packages/training/scripts/format_for_training.py`. Each line is one
trajectory turn flattened into a chat-style training record. The `format_id`
field on every line MUST equal `"eliza_native_v1"`.

### What triggers a v2

A v2 bump is required if **any one** of the following becomes true:

| Trigger                                                                 | Why it forces v2                                       |
|-------------------------------------------------------------------------|--------------------------------------------------------|
| Training adds tool-call / function-call structured fields               | New top-level keys break loader assumptions            |
| Multi-turn project trajectories ship (W1-S1) with `child_steps` inline  | Schema becomes recursive; v1 readers will silently drop|
| Reasoning blocks (W1-T1/T2/T3) embedded inside records                  | v1 has no `reasoning[]` slot                           |
| Sub-agent cost annotations (M40, W1-X1) are required for training       | New `cost_usd` field; existing training scripts can't filter on it without a version flag |
| GRPO reward-shaped trajectories need explicit `advantage` per step      | v1 has no per-step advantage field                     |

What does **not** force a v2: adding optional metadata fields that loaders can
safely ignore (additive, non-breaking).

### v1 → v2 migration plan (when triggered)

1. Land `format_id: "eliza_native_v2"` alongside v1 — both produced for a
   transition window of one full training cycle (≈ 1 week).
2. `format_for_training.py` accepts `--format eliza_native_v1|eliza_native_v2`;
   default switches to v2 only after step 5 passes.
3. Backfill: re-run `format_for_training.py` against historical trajectory rows.
   Trajectories are still raw in the DB (per A2), so re-encoding is lossless.
4. Trainer (`train_local.py`) loads v2; emit a clear error if v1 records are
   detected post-cutover.
5. Push a v2 dataset to HF as a new dataset branch (`dataset/v2`) before
   touching `dataset/main`. Validate one full train + eval cycle.
6. Flip default; mark v1 deprecated for one more cycle, then delete the
   `--format v1` branch.

### Non-goals

- No silent schema drift. Adding a field without a version bump is not allowed
  if any consumer reads it positionally or fails on `undefined`.
- No multi-format readers in training code. The trainer reads exactly one
  declared format per run.

---

## 2. Model promotion lifecycle

States are stored in the `model_versions` table (scaffolded in W0-X3).

| State        | Meaning                                                  | Who advances              | Required gates                                                                                    |
|--------------|----------------------------------------------------------|---------------------------|---------------------------------------------------------------------------------------------------|
| `developing` | Training in progress or just produced; no eval scores yet| `CheckpointSyncAgent` writes this on checkpoint pull | None (this is the entry state)                                                          |
| `candidate`  | Passed the eval suite; eligible for human/CI approval    | `PromotionService` (auto) | All `candidate`-gating benchmarks pass; score deltas vs incumbent ≥ threshold (see §4)            |
| `stable`     | Production. Served from `latest` HF branch + Vast.ai     | `PromotionService` (human-approved OR CI rule) | All `stable`-gating benchmarks pass; replay regression ≤ noise; security/PII audit signed off |
| `retired`    | No longer served; kept in registry for audit + rollback  | `PromotionService` (admin)| New model promoted to `stable` (auto-retire predecessor) OR explicit admin retire                 |

### Transition rules (strict)

```
developing ──auto(eval pass)──▶ candidate ──human|CI──▶ stable ──auto──▶ retired
                                    │
                                    └──auto(eval fail)──▶ retired
```

- A `developing` row must transition to `candidate` or `retired` within 24h of
  checkpoint completion. Stale `developing` rows are a bug.
- A model never returns to a prior state. Roll forward, never back. If a
  `stable` model has a bug, retire it and promote the previous `stable` from
  the registry (which means creating a new `stable` row pointing at the older
  artifact, not reanimating the retired row).
- Exactly one `stable` row per model family (e.g., `eliza-1-2b`, `eliza-1-9b`,
  `eliza-1-27b`) at a time. Promoting a new `stable` auto-retires the previous.
- `retired` is terminal.

### Who controls each transition

- `developing → candidate`: fully automated, gated by the eval suite (§4).
- `candidate → stable`: requires one of (a) human approval recorded in the UI,
  (b) CI rule passing the stricter `stable`-gating thresholds (§4).
- `stable → retired`: automated when a successor reaches `stable`. Manual
  retire requires admin.

---

## 3. HuggingFace branches

> **Stale section — to be rewritten.** The current release layout is a
> single consolidated bundle repo `elizaos/eliza-1` with per-tier
> subdirectories under `bundles/<tier>/...` and a single `main` branch.
> The per-tier-repo + three-branch pattern described below was the
> pre-rename plan; the active publish path (see
> `packages/training/scripts/publish/orchestrator.py`) ships into a
> single repo and lifecycle is tracked via the per-bundle
> `evidence/release.json` `releaseState` field instead of separate HF
> branches. Wave 3+ will rewrite this contracts doc against the actual
> bundle layout.

Each model family on HF (e.g., `elizaos/eliza-1-2b`) uses three named branches.
These branches are the *external* surface of the lifecycle in §2.

| Branch      | Pointer meaning                                          | Updated by                                       |
|-------------|----------------------------------------------------------|--------------------------------------------------|
| `main`      | Latest *anything* — newest checkpoint regardless of state. Public visibility but not "supported". | Every checkpoint push (also tagged `developing` or higher) |
| `candidate` | Newest `candidate` model. Used by the CI eval gate and beta testers. | `PromotionService` on `developing → candidate`   |
| `stable`    | Current `stable` model. This is what auto-download and Vast.ai serving pull. | `PromotionService` on `candidate → stable`       |

### Branch-flip rules

1. **`main` always moves forward.** Every push from training updates `main`.
   `main` is the firehose; consumers must not depend on its quality.
2. **`candidate` moves forward only via lifecycle transition.** No human pushes
   to `candidate` outside of `PromotionService`. Promotion writes the new
   commit hash to `candidate` and tags it with the `model_version_id`.
3. **`stable` only ever moves to a commit that has been on `candidate` first.**
   A `stable` flip without a prior `candidate` is rejected by `PromotionService`
   as a contract violation.
4. **Branch flips are atomic + tagged.** Each flip creates a git tag of the
   form `v<semver>-<state>` (e.g., `v0.3.1-stable`) so consumers can pin.
5. **Rollback is forward-only.** To "roll back" `stable`, promote the
   previous-good model as a new entry. Never `git reset` the branch.
6. **Release notes are mandatory** on `candidate → stable` flips. Generated
   from benchmark deltas + commit list by `PromotionService` (W1-H1).

### Consumer wiring

- `auto-download-recommended.ts` resolves model URL from `stable`.
- Vast.ai serving template (W1-D4) deploys from `stable`.
- CI eval workflow (W1-B5) pulls `candidate`.
- Local-inference registry (W1-H2) records `stable` URLs only.

---

## 4. Eval suite definition

Two suites: **candidate-gating** (block `developing → candidate`) and
**stable-gating** (block `candidate → stable`). The stable suite is a superset.

### Candidate-gating suite (fast, < 30 min on a single H100)

| Benchmark            | Source                                       | Why it's gating                         | Min delta vs incumbent stable      |
|----------------------|----------------------------------------------|-----------------------------------------|------------------------------------|
| MMLU                 | `lm-eval-harness` (W1-B1)                    | General knowledge floor                 | ≥ −0.5pp (no significant regression)|
| HumanEval            | `bigcode-evaluation-harness` (W1-B1)         | Code generation correctness             | ≥ +0.5pp (real win required)       |
| GSM8K                | `lm-eval-harness` (W1-B1)                    | Math reasoning                          | ≥ −1.0pp                           |
| Eliza action-calling | `eliza/packages/benchmarks/action-calling`   | Core agentic loop                       | ≥ +1.0pp on action-match accuracy  |
| BFCL                 | `eliza/packages/benchmarks/bfcl`             | Function-calling correctness            | ≥ −1.0pp                           |
| Trajectory replay    | W1-B4 (1000 historical trajectories)         | No regression on real user flows        | ≥ 95% step-sequence match          |

A model passes the candidate gate iff **every** row's delta meets its threshold.
A single regression → reject.

### Stable-gating suite (full, < 6 hours on 8× H100 cluster)

Inherits all candidate-gating benchmarks (with stricter thresholds) plus:

| Additional benchmark | Source                                       | Why stable-only                       | Min delta vs incumbent stable     |
|----------------------|----------------------------------------------|---------------------------------------|-----------------------------------|
| MMLU-Pro             | `lm-eval-harness` (W1-B1)                    | Harder knowledge floor                | ≥ −0.5pp                          |
| MBPP                 | `bigcode-evaluation-harness` (W1-B1)         | Code generation breadth               | ≥ +0.5pp                          |
| MATH                 | `lm-eval-harness` (W1-B1)                    | Hard math                             | ≥ −1.0pp                          |
| ARC-Challenge        | `lm-eval-harness` (W1-B1)                    | Reasoning                             | ≥ −0.5pp                          |
| HellaSwag            | `lm-eval-harness` (W1-B1)                    | Commonsense                           | ≥ −0.5pp                          |
| TruthfulQA           | `lm-eval-harness` (W1-B1)                    | Honesty floor                         | ≥ −1.0pp                          |
| MT-Bench             | `lm-eval-harness` MT-Bench runner            | Multi-turn quality                    | ≥ +0.1 on judge-mean              |
| SWE-bench (Verified) | `eliza/packages/benchmarks/swe_bench`        | Real-world coding tasks               | ≥ −1.0pp                          |
| Terminal-Bench       | `eliza/packages/benchmarks/terminal-bench`   | Shell + tool use                      | ≥ −1.0pp                          |
| PII leak audit       | W1-T11 + W3-V5                               | Hard gate, not score-based            | Zero hits = pass; any hit = reject|

**Stricter thresholds for inherited benchmarks at stable gate:**
HumanEval, action-calling, MBPP must each show **positive** delta ≥ +0.5pp
(not just no-regression). The stable gate exists to catch "passed candidate
but no real improvement" cases.

### Tie-breaking and noise

- "Noise threshold" per benchmark is the standard deviation across 3 reseeded
  runs of the *incumbent* model. Stored in `benchmark_runs` (W0-X5).
- A delta is "significant" only if it exceeds 1.5× the noise threshold.
- Negative deltas within noise count as "no regression".

### Cadence + caching

- Incumbent scores are cached by `(model_id, benchmark_id, dataset_version,
  code_commit)`. Re-run only when any tuple component changes.
- Candidate scores are computed fresh on every promotion attempt.

---

## 5. Cost-tracking schema

Per-LLM-call cost annotation lives on trajectory steps and is rolled up per
session. Required for both cloud and local providers (local cost = 0 USD but
the row exists to keep the rollup consistent).

### Field shape

| Field           | Type                | Required | Notes                                               |
|-----------------|---------------------|----------|-----------------------------------------------------|
| `provider`      | string              | yes      | `anthropic`, `openai`, `ollama`, `lm-studio`, `mlx`, `llama.cpp`, `vast-vllm`, `eliza-cloud` |
| `model`         | string              | yes      | Resolved model ID at call time (e.g., `claude-opus-4-7`) |
| `in_tok`        | integer             | yes      | Input tokens                                        |
| `out_tok`       | integer             | yes      | Output tokens                                       |
| `cached_tok`    | integer             | optional | Prompt-cache hits (Anthropic, OpenAI); 0 if unknown |
| `cost_usd`      | number              | yes      | Computed from per-provider price table; 0 for local |
| `ts`            | timestamp (UTC, ms) | yes      | Call start time                                     |
| `trajectoryId`  | uuid                | yes      | FK to `trajectories.id`                             |
| `stepId`        | uuid                | yes      | FK to the step row that owns the call               |
| `subAgentId`    | string              | optional | `PARALLAX_SESSION_ID` of the spawned sub-agent, if any |
| `priceTableId`  | string              | yes      | Reference to the versioned price table used         |

### Where it lives

- Trajectory step JSONB gets `cost` object (W1-X1).
- Aggregate `(provider, model, sum(cost_usd))` per session surfaced via
  `/api/training/cost/session/<id>`.
- Per-trajectory rollup column `total_cost_usd` on `trajectories` for fast UI.

### Price table

- Single JSON file `eliza/packages/training/lib/price_table.json`, keyed by
  `(provider, model)`, versioned with `priceTableId: "YYYYMMDD"`.
- Updated by hand when providers change pricing.
- `cost_usd` is computed at write time using the price table version
  *current at that moment*. Historical recompute is allowed but never silent.
- Local providers have `cost_usd: 0` and `priceTableId: "local-v1"`.

### What the schema does NOT include

- No GPU-hour cost on training runs. That's tracked separately under
  `vast.ai` job records (W1-D3), not in the trajectory cost schema.
- No human time cost. Out of scope.

---

## 6. Model-id registry shape

The dynamic HF catalog (M19, W1-H2) replaces the hardcoded 4-entry list in
code. Lives at `eliza/packages/local-inference/src/registry.json`, updated by
`PromotionService` on `stable` transitions. Never hand-edited.

### Top-level schema

```json
{
  "registryVersion": "1.0.0",
  "updatedAt": "2026-05-10T00:00:00Z",
  "families": {
    "eliza-1-2b":   { /* family entry */ },
    "eliza-1-9b":   { /* family entry */ },
    "eliza-1-27b":  { /* family entry */ }
  }
}
```

### Family entry

```json
{
  "displayName": "Eliza-1 2B",
  "hfRepo": "elizaos/eliza-1-2b",
  "currentStable": "v0.3.1",
  "currentCandidate": "v0.4.0-rc1",
  "variants": [
    {
      "variantId": "Q4_K_M",
      "quant": "Q4_K_M",
      "format": "gguf",
      "sizeBytes": 1700000000,
      "url": "https://huggingface.co/elizaos/eliza-1-2b/resolve/stable/eliza-1-2b-Q4_K_M.gguf",
      "minRamGb": 4,
      "minVramGb": 0,
      "recommendedFor": ["low-end-mac", "16gb-laptop"]
    },
    {
      "variantId": "Q6_K",
      "quant": "Q6_K",
      "format": "gguf",
      "sizeBytes": 2300000000,
      "url": "https://huggingface.co/elizaos/eliza-1-2b/resolve/stable/eliza-1-2b-Q6_K.gguf",
      "minRamGb": 8,
      "minVramGb": 0,
      "recommendedFor": ["mid-mac", "24gb-mac"]
    },
    {
      "variantId": "FP16",
      "quant": "FP16",
      "format": "safetensors",
      "sizeBytes": 4600000000,
      "url": "https://huggingface.co/elizaos/eliza-1-2b/resolve/stable/eliza-1-2b-fp16.safetensors",
      "minRamGb": 16,
      "minVramGb": 8,
      "recommendedFor": ["high-end-gpu", "vast.ai-serving"]
    }
  ],
  "benchmarks": {
    "MMLU": 0.512,
    "HumanEval": 0.481,
    "GSM8K": 0.443,
    "action-calling": 0.872
  },
  "releaseNotes": "https://huggingface.co/elizaos/eliza-1-2b/blob/stable/RELEASE_NOTES.md"
}
```

### JSON Schema (canonical)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["registryVersion", "updatedAt", "families"],
  "properties": {
    "registryVersion": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "updatedAt": { "type": "string", "format": "date-time" },
    "families": {
      "type": "object",
      "patternProperties": {
        "^[a-z0-9-]+$": { "$ref": "#/$defs/family" }
      }
    }
  },
  "$defs": {
    "family": {
      "type": "object",
      "required": ["displayName", "hfRepo", "currentStable", "variants", "benchmarks"],
      "properties": {
        "displayName": { "type": "string" },
        "hfRepo": { "type": "string", "pattern": "^[^/]+/[^/]+$" },
        "currentStable": { "type": "string" },
        "currentCandidate": { "type": ["string", "null"] },
        "variants": {
          "type": "array",
          "minItems": 1,
          "items": { "$ref": "#/$defs/variant" }
        },
        "benchmarks": {
          "type": "object",
          "additionalProperties": { "type": "number" }
        },
        "releaseNotes": { "type": "string", "format": "uri" }
      }
    },
    "variant": {
      "type": "object",
      "required": ["variantId", "quant", "format", "sizeBytes", "url", "minRamGb", "minVramGb", "recommendedFor"],
      "properties": {
        "variantId": { "type": "string" },
        "quant": { "enum": ["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "FP16", "BF16", "AWQ", "GPTQ"] },
        "format": { "enum": ["gguf", "safetensors", "mlx"] },
        "sizeBytes": { "type": "integer", "minimum": 1 },
        "url": { "type": "string", "format": "uri" },
        "minRamGb": { "type": "integer", "minimum": 0 },
        "minVramGb": { "type": "integer", "minimum": 0 },
        "recommendedFor": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    }
  }
}
```

### Update rules

- `PromotionService` is the only writer. Manual edits are reverted by CI.
- `currentStable` changes atomically with the HF branch flip (see §3).
- `currentCandidate` set on `developing → candidate`, cleared on
  `candidate → stable`.
- `updatedAt` set to the transaction time of the write.
- Registry is versioned. A bump to `registryVersion` requires a migration plan
  in this doc, same shape as §1's training-format migration.

### Lookup contract

- `auto-download-recommended.ts` matches detected hardware against
  `variants[*].recommendedFor` and `variants[*].minRamGb / minVramGb`. Picks
  the largest variant that fits.
- Local-inference plugin loads from `families[*].currentStable` URL.
- No code path is allowed to hardcode an HF repo URL outside this registry.

---

## 7. Sub-agent capture strategy (W0-X4)

The single largest training-data quality gap (C1). Eliza-1 is a coding agent;
the high-value reasoning lives in Claude Code / Codex / OpenCode sessions and
is currently discarded. We capture only ANSI-stripped stdout.

### Options considered

| Option | Mechanism                                                                       | Reliability                        | Requires upstream cooperation |
|--------|---------------------------------------------------------------------------------|------------------------------------|-------------------------------|
| **A**  | Post-session read of the sub-agent's own session log files                      | High (files exist on disk after task) | None                       |
| **B**  | PTY-level injection of a `TOOL_CALL:` stdout protocol                           | Medium (depends on sub-agent compliance) | None, but fragile across versions |
| **C**  | Native telemetry hook (the sub-agent calls back into our HTTP bridge)           | High when it works                 | Yes — upstream must implement |
| **D**  | Structured `DECISION:` stdout protocol the sub-agent prints                     | Medium — depends on prompt fidelity| Partial — prompt-only         |

### Decision matrix per sub-agent

| Sub-agent     | Primary strategy | Layered fallback / supplement | Rationale                                                                                          |
|---------------|------------------|-------------------------------|----------------------------------------------------------------------------------------------------|
| Claude Code   | **A**            | none                          | Writes complete JSONL session logs to `~/.claude/session-logs/*.json` (or workspace `.claude/...`). Lossless, reliable, no upstream coordination. |
| Codex (CLI)   | **A**            | none                          | `codex exec --output-last-message <path>` writes the final message; stream-events file captures intermediate state. No upstream change needed.    |
| OpenCode      | **D** + (A)      | (A) when streaming JSON not available | OpenCode's streaming JSON output is the natural fit, but availability varies by version. Wrap with `DECISION:` protocol where we control prompts. |
| Pi (local)    | **D**            | none                          | We own the prompt and the runtime. `DECISION:` channel is the contract. No external session log to parse. |

### Why this default

- **Option A for Claude Code + Codex.** Both products write durable session
  files we can read post-completion. No prompt-engineering required, no
  upstream coordination, no live-stream parsing complexity. The file is
  source-of-truth; we treat it as canonical.
- **Option D layered for OpenCode + Pi.** We control these prompts and (for
  Pi) the runtime entirely. A structured stdout protocol is the simplest
  contract we can enforce, and it survives version drift in the sub-agent.
- **Option B (PTY-level protocol injection) rejected as default.** Fragile
  across CLI updates. Useful as a last-resort fallback only.
- **Option C (native telemetry) rejected as default.** Requires upstream
  cooperation we cannot guarantee. Hold for future when Anthropic / Codex /
  OpenCode add first-class hooks; revisit then.

### What "capture" means concretely

For every sub-agent session, the parent trajectory step that spawned it MUST
have `childSteps[]` populated with normalized records:

| Field            | Source (Claude Code)                | Source (Codex)                      | Source (OpenCode)                  | Source (Pi)                |
|------------------|-------------------------------------|-------------------------------------|------------------------------------|----------------------------|
| `reasoning`      | `message.content[].thinking`        | stream-events `reasoning` blocks    | streaming JSON `reasoning` events  | `DECISION:` `reasoning` field |
| `toolCalls`      | `message.content[].tool_use`        | stream-events `tool_call` blocks    | streaming JSON `tool_call` events  | `DECISION:` `toolCalls` field |
| `toolResults`    | `message.content[].tool_result`     | stream-events `tool_result` blocks  | streaming JSON `tool_result` events| `DECISION:` `toolResults` field |
| `tokens.in`      | `usage.input_tokens`                | `usage.input_tokens`                | streaming JSON usage event         | runtime instrumentation    |
| `tokens.out`     | `usage.output_tokens`               | `usage.output_tokens`               | streaming JSON usage event         | runtime instrumentation    |
| `model`          | `model` field on message            | `model` field on stream event       | streaming JSON model field         | runtime instrumentation    |
| `cost_usd`       | computed via price table (§5)       | computed via price table (§5)       | computed via price table (§5)      | `0` (local)                |

### Privacy + write rules

- Sub-agent capture runs through the privacy filter (C9, W1-T11) before
  merging into the parent trajectory. PARALLAX_SESSION_ID, workspace paths,
  and parent step IDs are stripped at this seam (resolves A7).
- Raw session logs are kept in `~/.milady/workspaces/<sessionId>/.claude/...`
  (or equivalent) — same lifetime as the workspace itself, on user's machine.
- Only the normalized + filtered `childSteps[]` lands in the trajectory DB
  and in any downstream training format.

### Fallback chain (per session)

For each sub-agent type, if the primary strategy fails to produce records:

1. Log a warning step in the parent trajectory: `subagent_capture_failed`
   with the reason.
2. Fall back to ANSI-stripped stdout (current behavior) so the trajectory
   isn't lost entirely.
3. Tag the trajectory with `capture_quality: "degraded"` so training-format
   step can filter or downweight it.

Never silently lose data. Never silently substitute defaults for failure.

### Open questions (flagged, not blocking)

- Does Claude Code's session log path always live at
  `~/.claude/session-logs/*.json`, or is it workspace-local in newer versions?
  W1-T1 must verify against current Claude Code release.
- Codex stream-events format has changed between minor versions; the parser
  needs a version probe. W1-T2 must add it.
- OpenCode's streaming JSON flag may not be stable across versions. If we
  find it unreliable in practice, escalate Option D to primary for OpenCode
  too.

---

## 8. Cross-references

- **A1 (split trajectories):** addressed by §7 capture rules — parent step's
  `childSteps[]` is the merge point. Read-time JOIN no longer required.
- **A2 (privacy at export):** affirmed. Raw PII in DB is intentional;
  filtering at outbound paths (§5 cost has no PII; §7 capture filters; §1
  training format runs through W1-T11).
- **A3 (no benchmark cache):** addressed by §4's `(model_id, benchmark_id,
  dataset_version, code_commit)` caching in `benchmark_runs`.
- **A4 (prompt-injection seam):** out of scope for this doc; W1-P1 owns it.
- **A5 (per-action model routing):** out of scope; W1-R2 owns it.
- **A6 (training format versioning):** §1.
- **A7 (operational metadata leakage):** §7's privacy-filter step.
- **A8 (no current-best ownership):** §6's `currentStable` field is the
  canonical answer. All consumers read from registry.

---

## 9. Implementation notes for downstream waves

- W0-X3 (promotion registry schema) implements the SQL tables backing §2.
- W0-X5 (bench trending DB) implements the tables backing §4's score cache.
- W1-T1/T2/T3 implement §7's per-sub-agent parsers.
- W1-T11 owns the privacy-filter seam referenced from §1 and §7.
- W1-H1 (`PromotionService`) is the only writer to §2's `model_versions`,
  §3's HF branches, and §6's registry.
- W1-X1 implements §5's cost annotation.

If any of these implementations want to deviate from the contracts here, the
deviation MUST update this doc first and pass review. No silent contract
drift.
