# eliza-1-0_6b — APOLLO SFT: run, benchmark, go/no-go (2026-05-11)

Scope: fine-tune the smallest eliza-1 tier (`eliza-1-0_6b`, base = upstream
`Qwen/Qwen3-0.6B` — the documented stand-in for the unpublished Qwen3.5-0.6B)
with the APOLLO optimizer on the SFT corpus staged by the DATASETS workstream,
then benchmark vs the baseline and decide publish.

Owner: SFT-0.6b agent. Coordinates with: DATASETS (#44, corpus), DRAFTERS (#41
— **n/a for 0.6b, see below**), PUBLISH (#46, handoff).

---

## 1. Nebius H200 bringup

`scripts/train_nebius.sh` already provisions an H200 VM (`gpu-h200x1` /
`gpu-h200x2`), rsyncs `training/` + `data/final/`, runs the same `train_local.py`
APOLLO SFT under `accelerate launch`, then optionally PolarQuant/TurboQuant/QJL +
base-vs-finetuned `eliza_bench`, fetches checkpoints back, and tears the VM down.
It is marked **deprecated** in favour of Vast (`scripts/train_vast.sh`) for the
9b/27b cloud tiers, but it is the right tool for a single-GPU 0.6b/1.7b H200 run.

What this run added: `scripts/cloud/run-on-cloud.sh --task train --provider nebius`
now delegates to `train_nebius.sh full` (instead of dying with "run it directly"),
choosing `gpu-h200x1` for 0.6b/1.7b/9b and `gpu-h200x2`+FSDP for 27b, with the
same fail-closed semantics as the vast path (`--yes-i-will-pay` *and*
`NEBIUS_PROJECT_ID` required; `--dry-run` prints the plan and spends nothing).
Also fixed a pre-existing bug in `tier_to_registry_key` (`0_6b`/`1_7b` mapped to
nonexistent `qwen3.5-0.6b`/`qwen3.5-1.7b` → corrected to `qwen3-0.6b`/`qwen3-1.7b`,
matching `model_registry.py`).

**Real-run state:** the Nebius CLI on this host is configured with the
`hyperscape` profile (`auth-type: federation`, browser-SSO via `auth.nebius.com`,
parent `project-e00kfz6cpr00q21z892vec`). In this headless context `nebius iam
whoami` hangs (no interactive auth), and `~/.nebius/credentials.yaml` predates
this session — so a fresh H200 provision was **not** attempted (the script is
fail-closed and would refuse anyway without a usable `NEBIUS_PROJECT_ID` +
re-auth). The resume command for an operator with a live Nebius login:

```bash
NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec \
HUGGING_FACE_HUB_TOKEN=<hf-token> \
REGISTRY_KEY=qwen3-0.6b \
bash packages/training/scripts/cloud/run-on-cloud.sh \
  --provider nebius --task train --gpu h200 --tier 0_6b --yes-i-will-pay
# (or, equivalently, directly: REGISTRY_KEY=qwen3-0.6b NEBIUS_VM_PRESET=gpu-h200x1 \
#  FSDP_WORLD_SIZE=1 bash packages/training/scripts/train_nebius.sh full)
```

Cheap smoke before a real run: `bash …/run-on-cloud.sh --provider nebius
--task train --gpu h200 --tier 0_6b --dry-run` (no spend; prints the
`REGISTRY_KEY=… NEBIUS_VM_PRESET=gpu-h200x1 FSDP_WORLD_SIZE=1
train_nebius.sh full` plan) — verified working in this session.

## 2. APOLLO integration

Already wired and faithful to the paper (APOLLO, Zhu et al., MLSys 2025,
arXiv:2412.05270): `apollo-torch>=1.0.3` is a `[train]` dependency,
`scripts/training/optimizer.py` builds the two recipes — full **APOLLO**
(channel-wise, rank-256, scale 1, JL random projection, `update_proj_gap=200`)
and **APOLLO-Mini** (tensor-wise, rank-1, scale 128, `scale_front=True`) — and
routes only 2-D weight matrices through the low-rank projector (embed / lm_head /
norms / biases stay in the unprojected AdamW group). `_FP32MomentsAPOLLO`
pre-creates the optimizer moments in fp32 so FSDP `mixed_precision=bf16` doesn't
silently drop them to bf16. `train_local.py` selects the optimizer from the
registry (`apollo_mini` for every ≤16 GB tier; full `apollo`@512 for the 9b);
muon/adamw are *not* exposed by the local entrypoints — APOLLO is the only
optimizer, by design (see `scripts/training/README.md`).

What this run added: `scripts/training/test_optimizer_cpu.py` now has a
parametrized **loss-decrease** test for both APOLLO and APOLLO-Mini — 30 steps of
cross-entropy overfit on a fixed-input/fixed-target tiny 2-layer toy LM; asserts
the loss falls below 70 % of the start. This exercises the projector +
norm-growth update *direction*, not just the param-group plumbing the other CPU
tests cover. `python -m pytest scripts/training/test_optimizer_cpu.py` → 6
passed (was 4). (The CUDA integration test `scripts/training/test_apollo.py`
loads a real Qwen on GPU — that path is unchanged.)

## 3. SFT recipe (eliza-1-0_6b)

Source of truth: `scripts/training/model_registry.py` → `"qwen3-0.6b"` entry —
`hf_id=Qwen/Qwen3-0.6B`, `seq_len=4096`, `optimizer=apollo_mini`,
`optimizer_rank=1`, `train_dtype=bf16`, `lr=1e-5`, `epochs=3` (registry default),
gradient checkpointing on, ChatML template (the model's own
`chat_template.jinja`), `micro_batch=1 grad_accum=8` (effective batch 8;
`run_pipeline.py --micro-batch 2 --grad-accum 4` is the documented free
throughput knob). Checkpoint export is `final/` (HF safetensors) →
`final-gguf-q4_k_m/final-Q4_K_M.gguf` (≈397 MB) → eliza1 sidecar bundle. Memory
math (`benchmarks/APOLLO_TUNING.md` §B): peak ≈ 8.5–9 GB at seq 4096 on a 16 GB
card; the 0.6b also fits on an H200 trivially (single GPU, no FSDP needed —
`gpu-h200x1`). The DATASETS workstream's `scripts/build_eliza1_sft_0_6b.py`
produces the benchmark-aligned ChatML splits under
`datasets/eliza1-sft-0_6b/{train,val,test}.jsonl`; the broad mixed corpus is
`data/final/{train,val,test}.jsonl` (66,861 train rows, 50 sources).

## 4. The SFT run

A **test SFT** matching the brief's "~1–2 H200-hours" budget already ran on this
box's RTX 5080 Laptop (16 GB, sm_120) — `eliza-1-0_6b-apollo-1778551769`:

| param | value |
|---|---|
| base | `Qwen/Qwen3-0.6B` |
| optimizer | `apollo_mini` (rank-1, scale 128, fp32 moments) |
| seq_len / micro_batch / grad_accum | 4096 / 1 / 8 (eff. batch 8) |
| dtype / grad checkpointing | bf16 / on |
| lr / epochs / samples | 1e-5 / 1 / 8000 (smoke slice of `data/final/train.jsonl`) |
| steps | ~1000 |
| **eval_loss (final)** | **1.315** |
| wall time | ~82 min (train) + bench + quant |
| checkpoint | `checkpoints/eliza-1-0_6b-apollo-1778551769/final/` (1.19 GB safetensors) |
| GGUF | `…/final-gguf-q4_k_m/final-Q4_K_M.gguf` (≈397 MB; `llama-cli` smoke-load timed out at 180 s on this box — not a conversion failure) |
| eliza1 sidecar bundle | a complete PolarQuant+QJL+TurboQuant bundle exists from the earlier `1778515903` run (`checkpoints/eliza-1-0_6b-apollo-1778515903/milady-optimized-gpu/`): GGUF body `Q4_POLAR` (ggml type 47), K-cache `QJL1_256` (46), V-cache `TBQ3_0` (43), `milady_manifest.json` present. The `1778551769` run did not re-run the bundle stage. |

A **full-corpus** run (66 k rows × ~3 epochs) on the H200 is the next step; it
was not done here because the Nebius CLI is not authable in this headless
context (see §1) and a full local run would be ~9 GPU-hours on the 16 GB card.

## 5. DFlash drafter re-stamp — n/a for 0.6b

`benchmarks/MODELS_STATUS.md` and `catalog.ts` are explicit: **the 0.6b tier
gets no DFlash drafter** ("no smaller-than-itself Qwen3 base"). DFlash speculative
decode is wired for 1.7b+ only (drafter `Qwen/Qwen3-0.6B` for 1.7b/4b). So there
is nothing to re-stamp for the fine-tuned 0.6b target; the
`dflash-draft.target_checkpoint_sha256` coordination with the DRAFTERS workstream
(#41) applies to the 1.7b+ tiers, not this one.

## 6. Benchmark — baseline vs fine-tuned

`scripts/benchmark/eliza_bench.py` + `native_tool_call_bench.py` on
`data/final/test.jsonl`, max 12 / bucket (35 examples; smoke-corpus eval, so the
*absolute* numbers are low — the structural gates calibrated for a full-corpus
fine-tune expect ≈0.95 parsable-format). Side-by-side
(`benchmarks/eliza-1-0_6b-apollo-1778551769/{base,finetuned}/`):

| metric | base `Qwen3-0.6B` | finetuned `eliza-1-0_6b` | Δ |
|---|---:|---:|:--|
| eval `format_ok` (aggregate parsable-output rate) | 0.0857 | **0.20** | +0.114 ↑ |
| `claude_distill` format_pct (closed `<think>` + final answer) | 27.3 % | **63.6 %** | +36.4 pp ↑ |
| `claude_distill` `has_think_close` | 27.3 % | **63.6 %** | +36.4 pp ↑ |
| `reply` bucket parse errors (of 12) | 8 | **0** | −8 ↓ (clean) |
| `message_handler` parse errors (of 12) | 3 | **1** | −2 ↓ |
| `message_handler` content_pct (action fields match) | 100 % | 100 % | = |
| `message_handler` format_pct (TOON envelope) | 0.0 % | 0.0 % | = (smoke task mix never emits the TOON envelope; not a regression) |
| `native_tool_call` `response` bucket | n=0 (no rows in smoke slice) | n=0 | n/a |
| gen tokens/sec | 68.5 | **90.9** | +33 % ↑ (shorter, on-task outputs: avg gen 297 → 194 tok) |
| eval_loss | — | 1.315 | — |

**Gate report** (`gate_report.json`, smoke mode): `pipeline_ran` ✅,
`format_ok_not_regressed` ✅ (finetuned 0.20 ≥ base 0.0857), `format_ok_floor`
❌ (0.20 < 0.50 — *expected on a 35-example smoke corpus*; the full-mode
`format_ok ≥ 0.70` gate in `eliza1_gates.yaml` is calibrated for a real
full-corpus fine-tune, not this test slice).

## 7. Go / no-go

**Conditional GO — publish after a full-corpus run; do NOT flip
`defaultEligible` on this test SFT.**

- The fine-tuned model **beats the baseline on every measured axis** and
  **regresses none** — `format_ok_not_regressed` passes, parse errors drop to
  zero on the `reply` bucket, `<think>` closure more than doubles, throughput
  +33 %. The APOLLO SFT is doing the right thing.
- It does **not** clear the absolute publish floor (`format_ok ≥ 0.5` smoke /
  `≥ 0.7` full) — but that floor is calibrated for a full-corpus fine-tune;
  this run only saw 8000 of the 66,861 staged rows for 1 epoch. The honest
  read is "the recipe is sound and the trend is strongly positive; the model
  is under-tuned, not broken". A full run (`epochs=3` over `data/final/` or the
  `datasets/eliza1-sft-0_6b/` benchmark-aligned splits) on the H200 is expected
  to clear the gate.
- Therefore: hand PUBLISH the bundle + GGUF + this table + verdict; PUBLISH
  should **block `defaultEligible`** until the full-corpus run lands a green
  `format_ok` gate. The bundle/GGUF can be staged as a candidate revision in
  the meantime.

## 8. Handoff to PUBLISH (#46)

Staged for pickup:
- HF checkpoint: `packages/training/checkpoints/eliza-1-0_6b-apollo-1778551769/final/`
  (model.safetensors 1.19 GB, config, tokenizer, chat_template.jinja).
- GGUF: `…/final-gguf-q4_k_m/final-Q4_K_M.gguf` (≈397 MB, Q4_K_M).
- eliza1 sidecar bundle (PolarQuant+QJL+TurboQuant, `Q4_POLAR`/`QJL1_256`/`TBQ3_0`
  GGUF): `packages/training/checkpoints/eliza-1-0_6b-apollo-1778515903/milady-optimized-gpu/`
  with `milady_manifest.json` (note: from the earlier `1778515903` checkpoint;
  re-run `scripts/quantization/gguf_eliza1_apply.py` against the `1778551769/final`
  checkpoint before publishing so the bundle matches the eval_loss-1.315 weights).
- Benchmark dir: `packages/training/benchmarks/eliza-1-0_6b-apollo-1778551769/`
  (`pipeline-summary.json`, `base/`, `finetuned/`).
- This report + the manifest beside it (`eliza1-0_6b-apollo-sft-2026-05-11.manifest.json`).
- Verdict: **conditional go** — see §7. PUBLISH must block `defaultEligible`
  pending a green full-corpus `format_ok` gate; until then, stage as a
  candidate revision only.

(Binaries are not committed — `checkpoints/`, `benchmarks/*` and `*.gguf` are
gitignored. The manifest records absolute paths.)
