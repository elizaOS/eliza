# Dataset Critical Review — Eliza-Alignment Ranking + Filter Plan

**Date:** 2026-05-04
**Method:** Sampled 50 records per source. Measured eliza-format conformance against the running-agent gold standard (nubilio + scambench eliza_config). Read each adapter to understand what it produces vs what eliza actually expects.

## TL;DR

**The corpus is 99% non-eliza data wrapped in synthetic eliza envelopes.** Of 7.25M records, only ~61k (0.85%) come from a real eliza-style agent loop:

| Class | records | % | eliza-aligned? |
|---|---:|---:|---|
| **Gold standard** (nubilio + scambench `eliza` config) | 61,357 | 0.8% | ✅ |
| Synthetic eliza-wrapped tool-call (hermes, glaive, etc.) | ~3.5M | 48% | ⚠️ wrapped |
| reasoning_cot (kimi, opus, deepseek, glm) | ~1.0M | 14% | ❌ math/code, not agent |
| Shell-only (agent-trove, nemotron-terminal) | ~1.7M | 23% | ❌ terminal sims |
| n8n workflow gen | 296k | 4% | ❌ different domain |
| Other (mcp, qwen36, playwright) | ~700k | 10% | ⚠️ varies |

Most damning finding: every dataset that wasn't already eliza-shaped got the **default thought** literal `"Reply to the user."` or `"Call the tool to satisfy the request."` injected verbatim by the adapter. **50/50 records of hermes-3, hermes-omniforge-qwen36, aureth-corpus-hermes, scambench, and hermes-fc-v1 contain `"Reply to the user."` as the model's "thought".** This trains the model to emit that exact string instead of a real reasoning trace.

## Gold-Standard Reference

Real nubilio agent input/output (from `local-corpora/nubilio-trajectories/training-datasets/2026-04-30/action_planner_trajectories.jsonl`):

```json
{"messages": [
  {"role": "system",  "content": "you are remilio nubilio. coding agent built by nubs on milady's vps..."},
  {"role": "user",    "content": "task: Generate dialog and actions for remilio nubilio.\n\ncontext:\nPossible response actions: CHARACTER_ACTIONS, REOPEN_CODING_TASK, MANAGE_ISSUES, ..."},
  {"role": "model",   "content": "<response>\n  <thought>nubs said \"hi\". just a greeting. reply briefly, in character. no greeting back per style rules.</thought>\n  <actions>\n    <action><name>REPLY</name></action>\n  </actions>\n  <providers></providers>\n  <text>sup</text>\n  <simple>true</simple>\n</response>"}
]}
```

The eliza app-training extractor (`eliza/apps/app-training/src/core/trajectory-task-datasets.ts:288-294`) emits this exact 3-message shape with **roles `system / user / model`** and the response is the **XML envelope** the eliza runtime parses.

User's specification: "we're not using system prompt" — meaning at training time we render the system role into the prompt template but the supervised target is the model's response only. The `system / user / model` shape is preserved so the model learns the same conditioning it sees at inference.

## Per-Dataset Ranking (best → worst)

### Tier S — Gold (use 100%, generate more)

| Slug | Records | Format | Notes |
|---|---:|---|---|
| `nubilio-trajectories` | 5,041 | Real eliza task prompts (86%) + planner XML envelope rewrapped to TOON | This is THE gold corpus. Generate more. |

### Tier A — Eliza-aligned bench (mostly real, light fixes needed)

| Slug | Records | Issues |
|---|---:|---|
| `scambench` | 37,419 | Real scam-defense scenarios; 72% have memory turns. **Bug**: `availableActions` are lowercase (`refuse`, `escalate`, `accept`) but eliza canonical actions are uppercase (`REPLY`, `IGNORE`). **100% have `"Reply to the user."` default-thought leak**. Adapter needs fix. |
| `scam-defense-corpus` | 18,897 | 100% have memory; real scam defense; same lowercase action issue. Default-thought leak only on 2%. |

### Tier B — Tool-call agent traces (different framework, structurally similar)

These came from real tool-using agents but in a different framework. The shape can be salvaged.

| Slug | Records | Notes |
|---|---:|---|
| `tool-reasoning-toucan` | 565,867 | 100% planner envelope, 100% memory turns (avg 3.4). Actions like `TASK_CALL`. Solid — keep. |
| `agent-trove` | 1,567,812 | 100% memory (avg 6.5). 96% slim form (just thought+text). Mostly shell traces. **Massively over-represented** — sample down. |
| `nemotron-terminal-corpus` | 125,560 | 100% memory (avg 12.6). All shell. Long traces. Useful for shell_command. |
| `swebench-verified-opus-47` | 500 | 100% memory (avg 28.6 turns). Coding agent. Good shape but tiny. |
| `mcp-agent-training-data` | 21,328 | 22% planner envelope, 64% slim. **64% default-thought leak.** |

### Tier C — Tool-call instruction data (synthetic eliza wrapping)

These are NOT agent trajectories; they're tool-calling instructions that got the eliza envelope synthesized on top.

| Slug | Records | Why concerning |
|---|---:|---|
| `glaive-fc-v2` | 112,958 | Single-turn tool calls. 80% memory but it's just `[user, tool, assistant]` from ChatML. |
| `bitagent-tool-calling` | 551,285 | Same — synthetic conversations. |
| `dolci-instruct-tool-use` | 216,590 | Same — synthetic. 96% slim form. |
| `glaive-fc-v2-reasoning` | 99,998 | Same family. |
| `hermes-fc-v1` | 11,578 | **100% default-thought leak.** |
| `hermes-fc-thinking-v1` | 2,747 | Cleaner but still not eliza. |
| `regularizer-reasoning-tool` | 249,998 | 17 avg memory turns. Good multi-turn structure but synthetic. |
| `nemotron-rl-tool-use` | 83,963 | Same. |

### Tier D — Pure reasoning/coding (no agent, dominantly over-represented)

These have `availableActions: [REPLY, IGNORE]` injected even though the original source is "given a coding problem, output code". The eliza wrapping is fully fake.

| Slug | Records | Why filter heavily |
|---|---:|---|
| `kimi-k25-reasoning-1m` | 746,617 | 100% reasoning_cot. Long math/code reasoning. Memory=0. |
| `glm-51-reasoning-1m` | 218,584 | Same. |
| `opus-47-thinking-25k-ansulev` | 25,000 | Same. |
| `deepseek-v4-distill-8000x` | 7,716 | Same. |
| `qwen35-reasoning-700x` | 633 | Same. |
| `regularizer-reasoning-tool` | 249,998 | reasoning_cot + tool. |

### Tier E — Hermes family (massively over-represented + default-thought leak)

The Hermes datasets dominate the corpus (1.75M records / 24%). They're ChatML conversations from the Hermes-3 / Aureth / Carnice projects. Their wrapping is the most synthetic.

| Slug | Records | Default-thought leak |
|---|---:|---|
| `hermes-3` | 958,829 | **50/50** |
| `aureth-corpus-hermes` | 326,765 | **50/50** |
| `hermes-omniforge-qwen36` | 320,000 | **50/50** |
| `hermes-agent-reasoning-traces` | 22,347 | unknown |
| `hermes-agent-traces-filtered` | 3,182 | |
| `hermes-reasoning-tool-use` | 51,004 | |
| `hermes-fc-thinking-v1` | 2,747 | |
| `hermes-fc-v1` | 11,578 | **50/50** |
| `nemotron-nano-hermes-traces` | 28,000 | |
| `talos-kimi-hermes` | 2,747 | |
| `carnice-glm5-hermes` | 22,969 | |

### Tier F — Domain-specific (n8n)

296k records of n8n workflow JSON. Not eliza tasks; the model would never see this kind of input from a real eliza session. Massively over-represented for what is essentially one task type.

### Tier G — Empty / noisy

| Slug | Records | Issue |
|---|---:|---|
| `claude-distills` | varies | 0% planner envelope, 0% slim — adapter confused |
| `mcp-routing-dataset` | varies | 1/50 valid, looks broken |

---

## Concrete filter proposal

### 1. Fix `availableActions` casing

In `scripts/lib/adapters.py` `scambench_passthrough` and `scam_defense_corpus`, normalize:
```
refuse        → IGNORE
escalate      → REPLY  
accept        → REPLY
ignore        → IGNORE
request-verification → REPLY
audit         → REPLY
```
Eliza runtime parsers expect uppercase canonical action names.

### 2. Eliminate the `"Reply to the user."` / `"Call the tool…"` default-thought leak

In `_planner_envelope()` and friends:
- When upstream has no `<think>` block / no `_pending_thought` / no `analysis` field, **don't synthesize a thought at all**. Drop the record OR use a varied template (5-10 phrasings randomly chosen) instead of the literal string. Better: generate a real one-line summary of the user's request.

The current behavior trains the model to literally say `Reply to the user.` for every turn. Inspect any model output today and you'll see it.

### 3. Per-source caps + sampling

Set hard caps per source so no single dataset can dominate. Updated `pack_dataset.py` config:

| Tier | Cap per source |
|---|---:|
| S (nubilio) | full corpus + replicate × 5 |
| A (scambench, scam-defense) | full corpus |
| B (toucan, agent-trove, nemotron-terminal) | 50,000 |
| C (glaive, bitagent, dolci, mcp) | 30,000 |
| D (kimi, glm, opus reasoning) | 15,000 |
| E (hermes family, ALL combined) | 100,000 (split across all hermes sources) |
| F (n8n) | 50,000 |
| G (broken) | 0 — drop |

Total post-filter: ~600k records (down from 7.25M). At 3 epochs × 600k = 1.8M training steps, more than enough for a 27B fine-tune.

### 4. Near-duplicate filtering

Within each source, dedup near-duplicates by:
- MinHash + LSH on the user-prompt content (Jaccard ≥ 0.8 collapses)
- Drop records whose `expectedResponse` first 200 chars is identical (catches templated outputs in n8n & glaive)

`pack_dataset.py` already deduplicates exactly. Add a `--near-dedup` flag using `datasketch`.

### 5. Quality heuristics — reject records where:

- `expectedResponse` is < 30 chars (too short to teach anything)
- `expectedResponse` is > 30,000 chars (Liger chunk_size won't help; OOM risk)
- `currentMessage` is empty or all-whitespace
- The model output is just `OK.` / `Done.` / `<empty>` (low-effort upstream)
- `"Reply to the user."` appears verbatim in `expectedResponse` (default-thought leak)

### 6. Action-distribution rebalance

Today's distribution (from manifest sample):
- `agent_trace` 46%, `reply` 16%, `shell_command` 16%, `reasoning_cot` 15%, `n8n` 4%, `tool_call` 2%, `scam_defense` 0.8%

Target distribution for 100% eliza-aligned training:
- `should_respond` / `should_respond_with_context` 25% (currently <0.1%!)
- `agent_trace` (planner) 25%
- `reply` 20%
- `tool_call` / `mcp_tool_call` 15%
- `scam_defense` 10%
- `reasoning_cot` 5% (drop most kimi/glm/opus)
- `n8n_workflow_generation` 0% (separate fine-tune)

The corpus has ~50× too little `should_respond` data — that's the most-called eliza endpoint and the model will be terrible at it.

---

## Synthetic eliza-data generation plan

### Use case: spin up a local milady agent, drive it through scenarios, capture trajectories

The eliza app-training pipeline already supports this:

1. **Trajectory capture is on by default** (`trajectory_collector` service in `eliza/apps/app-training/src/services/`). Every `runtime.useModel()` call writes to PGlite trajectory tables.

2. **Trajectory export cron** (`eliza/apps/app-training/src/core/trajectory-export-cron.ts`) flushes trajectories to JSONL per-task in `~/.milady/training-datasets/{date}/{task}_trajectories.jsonl`. Format is identical to nubilio — `{messages:[{role,content}]}`.

3. **What we need to generate** (per-task targets):
   - `should_respond`: 50,000 prompts. Drive the agent in a busy room with mixed-relevance messages.
   - `context_routing`: 30,000. Same setup; let the routing classifier fire.
   - `action_planner`: 50,000 across all common eliza action namespaces.
   - `response`: 30,000 free-form replies from the planner's REPLY action.

### Synthetic generation rig

Three parts:

**(a) Scenario library** — `data/synth/scenarios/*.yaml` defining:
- Room context (channel type, members, recent history)
- User personas + message styles
- Available action set
- Expected behavior class (scam? routine? off-topic?)

We already have ~1,500 lifeops + ea scenarios baked into the Qwen-formatted training data (the `lifeops.*` task_types in pack_dataset). Lift those into actual eliza scenarios.

**(b) Driver script** — `scripts/synth/drive_eliza.py`:
- Spawns the milady agent locally with a configured character
- Streams scenarios as user messages via the eliza HTTP endpoint
- Lets the agent's full pipeline run (should_respond → context_routing → action_planner → response)
- Captures trajectories via the existing service

**(c) Privacy filter pass** — `eliza/apps/app-training/src/core/privacy-filter.ts` (already exists). Run before export.

### Cost estimate

To generate 200k synthetic eliza trajectories:
- ~5s per scenario (full pipeline = 4 LLM calls @ ~1s each on local 16GB GPU)
- 200k × 5s = ~12 days on a single local GPU — too slow
- Or 200k × 5s ÷ 8 parallel workers × cloud H200 = ~3.5 hours = ~$20

**Recommendation**: run the synth pipeline on a Vast.ai blkw6000-1x ($0.93/hr × ~5h = $5) using a 9B model as the synth source. This is cheaper than buying tokens from Together.

---

## Action items (priority order)

1. **Fix the default-thought leak** in `scripts/lib/adapters.py`. This is probably the single most-impactful bug — the model literally learns to say "Reply to the user." as its thought. (~1 hour)
2. **Drop or recategorize `claude-distills` and `mcp-routing-dataset`** — they're broken in normalization. (~30 min)
3. **Normalize lowercase scambench actions** to uppercase. (~15 min)
4. **Re-run pack with new caps** (Tier S/A full, Tier B-E capped, Tier G dropped). Target output: ~600k records. (~30 min)
5. **Set up trajectory generation rig** (scripts/synth/drive_eliza.py) on top of the existing eliza app-training service. (~1 day)
6. **Run synthetic generation** to add 200k high-quality eliza trajectories. (~5 hours, ~$5 on Vast)
7. **Re-pack** with synthetic data + retrained quality filters. Target: 800k records, ~80% eliza-aligned. (30 min)
8. **Re-train** 2B/9B/27B on the cleaned corpus.

After this, format conformance on `eliza_bench` should jump from the current ~0% on smoke runs to >85% on the cleaned corpus.

---

## What "100% eliza-aligned" looks like

After the proposed filters + synth additions:

| Source | Records | % of corpus | What it teaches |
|---|---:|---:|---|
| nubilio-trajectories | 30,000 (5×) | 4% | Real coding agent behavior |
| nubilio-synthetic (new) | 200,000 | 25% | Same agent, more scenarios |
| scambench | 37,419 | 5% | Scam defense |
| scam-defense-corpus | 18,897 | 2% | Scam defense |
| toucan (Tier B sample) | 50,000 | 6% | Tool-using agent traces |
| agent-trove (Tier B sample) | 50,000 | 6% | Multi-turn agent |
| nemotron-terminal (Tier B) | 50,000 | 6% | Shell agent |
| Hermes family (combined cap) | 100,000 | 13% | General assistant |
| Tool-call instruction (combined) | 90,000 | 11% | Tool selection |
| reasoning_cot (combined cap) | 60,000 | 8% | Reasoning patterns |
| n8n_workflow_generation | 50,000 | 6% | Workflow domain |
| Other long-tail | 60,000 | 8% | Coverage |
| **TOTAL** | **~800,000** | 100% | |

**Eliza-native fraction goes from 0.8% → 36%** with realistic budgets.
