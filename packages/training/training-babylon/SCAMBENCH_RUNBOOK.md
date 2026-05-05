# Babylon ScamBench Data Runbook

This runbook is for Babylon scam-defense work only.

- Canonical benchmark: ScamBench
- Canonical paper theme: gullibility / scam resistance for autonomous agents
- Primary training target: `Qwen/Qwen3.5-9B`
- Fast iteration target: `Qwen/Qwen3.5-4B`
- Frontier baselines: `gpt-5.4` and `claude-sonnet-4.6`
- Explicitly out of scope here: `mevresearch/`

## What This Repo Already Has

- Babylon runtime and training code:
  `/Users/shawwalters/babylon-workspace/babylon`
- ScamBench benchmark package:
  `/Users/shawwalters/babylon-workspace/scambench`
- External prompt-injection / jailbreak source mirrors:
  `/Users/shawwalters/babylon-workspace/external-sources`
- Paper and generated experiment summaries:
  `/Users/shawwalters/babylon-workspace/paper`

The important point is that Babylon and ScamBench are already connected.
This is not a blank-slate plan. The job is to make the existing data path
operational, documented, and adapter-ready.

## Canonical Outcome

We need one defensible loop:

1. Generate Babylon-native data.
2. Ingest external prompt-injection and scam datasets.
3. Re-synthesize them into Babylon / ScamBench formats.
4. Export trainable trajectories.
5. Train Qwen variants, starting with `Qwen/Qwen3.5-9B`.
6. Benchmark baseline vs trained models on ScamBench.
7. Compare against frontier baselines and external agent runtimes.

## Repo Map

- Babylon-native generation:
  `/Users/shawwalters/babylon-workspace/babylon/packages/engine/examples/generate-training-data.ts`
- Babylon trust corpus collection:
  `/Users/shawwalters/babylon-workspace/babylon/scripts/collect-trust-experiment-corpus.ts`
- Babylon trust trajectory export:
  `/Users/shawwalters/babylon-workspace/babylon/scripts/export-trust-experiment-trajectories.ts`
- ScamBench scenario seeding into Babylon chats:
  `/Users/shawwalters/babylon-workspace/babylon/packages/engine/src/services/scambench-scenario-seeding-service.ts`
- Canonical external-data review and materialization:
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts/review_hf_scam_datasets.py`
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts/materialize_external_scam_data.py`
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts/materialize_prompt_injection_sources.py`
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts/materialize_clawbench_sources.py`
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts/merge_materialized_scam_corpora.py`
- Lightweight benchmark-only ETL / re-synthesis:
  `/Users/shawwalters/babylon-workspace/scambench/scripts/hf_etl.py`
  `/Users/shawwalters/babylon-workspace/scambench/scripts/resynthesize.py`
- ScamBench catalog builder and scorer:
  `/Users/shawwalters/babylon-workspace/scambench/src/catalog.ts`
  `/Users/shawwalters/babylon-workspace/scambench/src/index.ts`
- Babylon export for local fine-tuning:
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts/export_scam_defense_trajectories.py`
- Local training:
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts/train_local.py`
- Local direct benchmarking:
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts/run_scambench_local.py`
- Remote unified matrix:
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts/run_nebius_unified_matrix.py`

## Data Lanes

There are three data lanes and they should stay distinct until export time.

### 1. Babylon-native trajectories

Use this lane for real Babylon behavior, live chats, runtime rollouts, and
agent interaction traces.

Primary entrypoints:

```bash
cd /Users/shawwalters/babylon-workspace/babylon
bun run packages/engine/examples/generate-training-data.ts --causal --hours 2

bun run scripts/collect-trust-experiment-corpus.ts
bun run scripts/export-trust-experiment-trajectories.ts --manifest <manifest-path>
```

Use this lane for:

- live or simulated Babylon chat behavior
- agent gullibility traces from the actual runtime
- data that should preserve Babylon interaction style

### 2. External threat corpora

Use this lane for public scam datasets, prompt-injection datasets, jailbreak
corpora, and real-world scenario text that must be normalized before training.

Canonical Babylon path:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/python
python scripts/review_hf_scam_datasets.py
python scripts/materialize_external_scam_data.py
python scripts/materialize_prompt_injection_sources.py
python scripts/materialize_clawbench_sources.py
python scripts/merge_materialized_scam_corpora.py \
  --input-dir /Users/shawwalters/babylon-workspace/babylon/training-data/external-scam-materialized/<timestamp> \
  --input-dir /Users/shawwalters/babylon-workspace/babylon/training-data/prompt-injection-materialized/<timestamp> \
  --input-dir /Users/shawwalters/babylon-workspace/babylon/training-data/clawbench-materialized/<timestamp>
```

This produces:

- reviewed dataset inventories
- Babylon-shaped `training_examples.jsonl`
- curated `scambench_curated_scenarios.json`
- merged threat bundles for training and evaluation

### 3. Benchmark-only re-synthesis

Use this when you want fast ScamBench scenario generation without committing the
result to the canonical Babylon materialization path yet.

```bash
cd /Users/shawwalters/babylon-workspace/scambench
python scripts/hf_etl.py download --output-dir ./hf-raw
python scripts/resynthesize.py --input ./hf-raw --output ./hf-scenarios/all.json --seed 42
```

This lane is useful for:

- rapid prompt-injection family expansion
- static scenario authoring
- exploratory benchmark growth before canonizing a source

## Canonical External Source Mix

Prompt-injection and jailbreak coverage should continue to use these source
families, because they are already wired into the materializers:

- `awesome-prompt-injection` for taxonomy and attack family indexing
- `L1B3RT4S` for concrete jailbreak and liberation payloads
- `CL4R1T4S` for disclosure and tool / system-prompt pressure
- `OBLITERATUS` for anti-refusal framing and adjacent coercive prompts
- reviewed Hugging Face scam corpora for social engineering, impersonation, and long-con behavior
- `trajectoryRL/clawbench` for deterministic workplace-assistant scenarios with embedded safety, confidentiality, and unauthorized-action checks

ClawBench note:

- the upstream `Security Check` theme is still planned, not yet a standalone data lane
- today we ingest the real workplace scenarios and extract their security-relevant rubric items
- use ClawBench for deterministic multi-tool simulation and additional safety signals, not as proof that an upstream security theme already exists

The rule is simple:

- detector-style rows do not go directly into policy SFT
- conversation-style and re-authored rows can become Babylon trajectories
- benchmark scenarios should stay curated, not raw dumps

## Build The Unified ScamBench Catalog

Use the merged threat bundle when you want the benchmark to reflect both
Babylon-native and external material.

```bash
cd /Users/shawwalters/babylon-workspace/scambench
bun run src/catalog.ts \
  --external-scenarios /Users/shawwalters/babylon-workspace/babylon/training-data/merged-threat-materialized/<timestamp>/scambench_curated_scenarios.json \
  --output ./generated/scenario-catalog-unified-merged.json
```

Use this catalog for:

- baseline vs trained Qwen comparisons
- frontier baseline comparisons
- adapter validation for Hermes / OpenClaw / ElizaOS

## Babylon-Native Red-Team Replay

ScamBench is not only offline evaluation. It can also be replayed into Babylon.

Use:

- `/Users/shawwalters/babylon-workspace/babylon/packages/engine/src/services/scambench-scenario-seeding-service.ts`

This is the bridge from:

- static benchmark scenarios

to:

- real Babylon group chats
- DMs
- shared context refresh
- runtime trajectory collection

Operationally, this is how we should generate interactive red-team data against
our own agents instead of keeping ScamBench isolated from Babylon.

## Export The Training Set

The canonical export script now resolves ScamBench from this workspace layout
and can combine Babylon-native and external materialized data.

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/python
python scripts/export_scam_defense_trajectories.py \
  --include-external-materialized \
  --external-materialized-dir /Users/shawwalters/babylon-workspace/babylon/training-data/merged-threat-materialized/<timestamp> \
  --examples-per-trajectory 8 \
  --held-out-ratio 0.15 \
  --held-out-seed 42 \
  --include-format-recovery
```

Expected output:

- `trajectories.jsonl`
- `held-out/trajectories.jsonl`
- optionally format-recovery examples for Babylon output-shape stability

## Training Plan

### Primary paper track

Primary model family:

- `Qwen/Qwen3.5-9B`

Why:

- this is the model family the runbook should prioritize for the gullibility paper
- it is the most important small-model checkpoint to compare against frontier baselines

### Fast iteration track

Use:

- `Qwen/Qwen3.5-4B`

Why:

- faster local iteration
- cheaper ablations
- useful for recipe debugging before spending GPU budget on 9B

### Local training

Plan the Qwen capacity envelope before changing hardware, sequence length, or
the base checkpoint:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training
make qwen-capacity MODEL=9b CONTEXTS=128k,256k TRAINING_SEQ_LENGTH=8192
```

For the planner internals and interpretation notes, use:

- `/Users/shawwalters/babylon-workspace/babylon/packages/training/QWEN_CAPACITY_RUNBOOK.md`

Example MLX-style 9B run:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/python
python scripts/train_local.py \
  --backend mlx \
  --model mlx-community/Qwen3.5-9B-MLX-4bit \
  --source-dir /Users/shawwalters/babylon-workspace/babylon/training-data/scam-defense-export/<timestamp> \
  --output /Users/shawwalters/babylon-workspace/babylon/trained_models/scam-defense-qwen35-9b \
  --iters 20 \
  --batch-size 1 \
  --max-seq-length 512 \
  --sample-profile raw \
  --validate
```

Example CUDA / Transformers run:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/python
python scripts/train_local.py \
  --backend cuda \
  --model Qwen/Qwen3.5-4B \
  --source-dir /Users/shawwalters/babylon-workspace/babylon/training-data/scam-defense-export/<timestamp> \
  --output /Users/shawwalters/babylon-workspace/babylon/trained_models/scam-defense-qwen35-4b-qlora \
  --auto-detect-held-out \
  --optimizer adamw \
  --quantization nf4 \
  --lora \
  --lora-rank 32 \
  --max-steps 100 \
  --batch-size 1 \
  --gradient-accumulation-steps 8 \
  --max-seq-length 4096 \
  --sample-profile raw \
  --validate
```

Example canonical local pipeline run:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/python
python scripts/run_pipeline.py \
  --mode train \
  --training-backend local \
  --trajectory-source local_export \
  --source-dir /Users/shawwalters/babylon-workspace/babylon/training-data/scam-defense-export/<timestamp> \
  --local-backend cuda \
  --local-model Qwen/Qwen3.5-4B \
  --local-quantization nf4 \
  --local-lora \
  --local-lora-rank 32 \
  --local-max-seq-length 4096 \
  --local-gradient-accumulation-steps 4 \
  --local-steps 100
```

### Remote training

Use Nebius when 9B no longer fits comfortably on the local machine:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/python
python scripts/run_nebius_unified_matrix.py \
  --base-model Qwen/Qwen3.5-9B \
  --gpu-type h200 \
  --dry-run
python scripts/run_nebius_unified_matrix.py \
  --base-model Qwen/Qwen3.5-9B \
  --gpu-type h200
```

Current operational guidance:

- `Qwen/Qwen3.5-9B` is the canonical single-VM Nebius paper track
- start with `h200` for the 9B APOLLO matrix path
- `Qwen/Qwen3.5-122B-A10B` should stay on a cluster-oriented path, not this VM helper

## Benchmark Plan

### Direct local benchmarking

Use the direct local scorer for baseline vs trained Qwen comparisons:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/python
python scripts/run_scambench_local.py \
  --backend cuda \
  --device cuda \
  --base-model Qwen/Qwen3.5-9B \
  --label baseline-qwen35-9b \
  --output /Users/shawwalters/babylon-workspace/scambench/results/local-eval/baseline-qwen35-9b-decisions.json \
  --scenario-catalog /Users/shawwalters/babylon-workspace/scambench/generated/scenario-catalog-unified-merged.json \
  --score
```

Repeat with the trained adapter or merged checkpoint and compare:

- overall score
- attack-vs-legitimate balance
- comply counts
- leaked-secret counts

### Frontier baselines

Use:

- `/Users/shawwalters/babylon-workspace/scambench/targets/frontier-baselines.json`

That file already includes:

- `gpt-5.4`
- `claude-sonnet-4.6`
- local Qwen baselines

Run:

```bash
cd /Users/shawwalters/babylon-workspace/scambench
bun run src/index.ts \
  --targets ./targets/frontier-baselines.json \
  --target-repo /Users/shawwalters/babylon-workspace/babylon \
  --external-scenarios /Users/shawwalters/babylon-workspace/babylon/training-data/merged-threat-materialized/<timestamp>/scambench_curated_scenarios.json \
  --output-dir ./results/frontier-baselines
```

Operational note:

- `claude-sonnet-4.6` should be served behind an OpenAI-compatible proxy such
  as LiteLLM before using the ScamBench multi-target runner

## External Agent Adapters

We need three adapter tracks, but they are not at the same maturity level.

### Hermes

Status:

- usable now

Local code:

- bridge client:
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/src/training/hermes_bridge.py`
- local ScamBench runner:
  `/Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts/run_hermes_scambench_local.py`
- harness:
  `/Users/shawwalters/babylon-workspace/scambench/harnesses/hermes_harness.py`

Run:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/python
python scripts/run_hermes_scambench_local.py \
  --model mlx-community/Qwen3.5-4B-MLX-4bit \
  --base-url http://127.0.0.1:8099/v1 \
  --label hermes-qwen35-4b \
  --output /Users/shawwalters/babylon-workspace/scambench/results/hermes/hermes-qwen35-4b-decisions.json \
  --score-output-dir /Users/shawwalters/babylon-workspace/scambench/results/hermes/score \
  --target-repo /Users/shawwalters/babylon-workspace/babylon
```

Research-backed note:

- Hermes is an official agent runtime with a CLI and messaging gateway, but our
  benchmark bridge is custom. That is fine; it is currently the cleanest path.

### OpenClaw

Status:

- planning only
- current harness is experimental and not yet aligned with the official Gateway surface

Local code:

- provisional harness:
  `/Users/shawwalters/babylon-workspace/scambench/harnesses/openclaw_harness.py`

What the adapter should do next:

1. Replace the provisional REST assumptions with a Gateway-aware adapter.
2. Treat OpenClaw as a self-hosted gateway with sessions and routing, not as a
   generic `/api/chat` server.
3. Build a small sidecar bridge, similar to Hermes, that can turn ScamBench
   stage prompts into OpenClaw session messages and capture final responses.

### ElizaOS

Status:

- partially implemented
- message / room model is compatible with ScamBench, but the memory surface
  needs docs-backed alignment and the runner needs the same maturity as Hermes

Local code:

- harness:
  `/Users/shawwalters/babylon-workspace/scambench/harnesses/elizaos_harness.py`

What the adapter should do next:

1. Keep using ElizaOS agent and room APIs for scenario turns.
2. Align memory injection with the documented memory routes.
3. Add a dedicated recorded-decision runner, parallel to Hermes, so ElizaOS can
   be scored through the exact same `--decisions` path.

## Adapter Priority

Use this order:

1. Hermes
2. ElizaOS
3. OpenClaw

Reason:

- Hermes already has a working bridge in this repo
- ElizaOS has a documented REST surface and is close to usable
- OpenClaw appears to want a gateway-native adapter, not the placeholder REST
  harness that exists today

## Current Gaps That Matter

- some older docs and scripts assumed `benchmarks/scambench`; this workspace
  uses `/Users/shawwalters/babylon-workspace/scambench`
- the 9B path should become the default paper path, but some matrix tooling is
  still named around 4B runs
- OpenClaw needs a real adapter, not a guessed REST shim
- ElizaOS needs a first-class recorded-decision runner
- benchmark replay into live Babylon chats should become a scheduled data source,
  not just a manual debugging path

## External References

- Hermes official repo:
  <https://github.com/NousResearch/hermes-agent>
- Hermes docs:
  <https://hermes-agent.nousresearch.com/docs>
- OpenClaw official repo:
  <https://github.com/openclaw/openclaw>
- OpenClaw docs:
  <https://docs.openclaw.ai>
- ElizaOS official repo:
  <https://github.com/elizaos/eliza>
- ElizaOS docs:
  <https://docs.elizaos.ai>

## Recommended Default Operating Sequence

When in doubt, do this:

1. Generate or collect Babylon-native gullibility data.
2. Refresh external scam and prompt-injection materialization.
3. Merge the threat bundles.
4. Rebuild the unified ScamBench catalog.
5. Export held-out training trajectories.
6. Train `Qwen/Qwen3.5-4B` for recipe validation.
7. Train `Qwen/Qwen3.5-9B` for the paper track.
8. Benchmark baseline vs trained Qwen on ScamBench.
9. Run `gpt-5.4` and `claude-sonnet-4.6` as frontier baselines.
10. Run Hermes, then ElizaOS, then OpenClaw once the adapters are ready.

That is the Babylon data runbook.
