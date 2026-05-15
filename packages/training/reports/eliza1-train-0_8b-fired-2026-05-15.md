# Eliza-1 0_8b APOLLO training — T18 attempt — 2026-05-15

Operator brief (T18, follow-up to T17): satisfy preflight Gate 5, fix the
train_vast.sh:607 rsync exclude so RESUME_FROM_CHECKPOINT works, then fire
the paid Vast H100 dispatch with `--resume-from checkpoint-1000`.

**Outcome: Vast run NOT fired. Smoke produced a Gate-5-failing summary
(content_pct=0.0 across all buckets) and the full-stack smoke also crashed
at STEP 5 on a vendored quant kernel that does not support Qwen3.5's
hybrid-attention backbone. Per the brief's hard constraint
("DO NOT bypass any preflight gate"), aborted before paying.**

## 1. train_vast.sh rsync fix — DONE

`packages/training/scripts/train_vast.sh` `sync_tree()` (lines ~625-639,
appended after the existing `data/final/` rsync block).

Diff summary: when `RESUME_FROM_CHECKPOINT` is set, after the main
`--exclude='checkpoints/'` rsync runs, ship that one checkpoint dir
explicitly. This keeps the default behavior (don't ship every old
checkpoint) but makes `RESUME_FROM_CHECKPOINT` actually functional —
T17's caveat is now resolved.

```bash
if [ -n "${RESUME_FROM_CHECKPOINT:-}" ]; then
  local _resume_local="$ROOT/$RESUME_FROM_CHECKPOINT"
  if [ ! -d "$_resume_local" ]; then
    log_err "RESUME_FROM_CHECKPOINT=$RESUME_FROM_CHECKPOINT not found at $_resume_local"
    exit 2
  fi
  ssh_run "mkdir -p $REMOTE_TRAIN_DIR/$(dirname "$RESUME_FROM_CHECKPOINT")"
  rsync_remote to "$_resume_local/" "$REMOTE_TRAIN_DIR/$RESUME_FROM_CHECKPOINT/"
fi
```

Picked the surgical option (a) per the brief — adds an extra targeted
rsync rather than HF-staging the checkpoint to a temp repo. Net diff is
~14 lines added; no semantic change to the default codepath when
`RESUME_FROM_CHECKPOINT` is unset.

## 2. data/smoke symlink

`packages/training/data/smoke -> final-eliza1-smoke` (uncommitted; it's a
local convenience symlink, not part of the repo). The smoke script reads
`data/smoke/{train,val}.jsonl` but `build_eliza1_smoke_corpus.py` writes
to `data/final-eliza1-smoke/`. Without the symlink, smoke step 2 errors
out at "no train file". The symlink is a no-op for the trainer (HF Trainer
follows symlinks transparently).

## 3. Smoke result — FAILED (Gate 5 unsatisfiable, plus quant-kernel crash)

Command: `bash packages/training/scripts/smoke_full_stack.sh --registry-key qwen3.5-0.8b`
(plus `uv sync --extra train --extra serve` first; T17 had not installed
vLLM in the local venv — STEP 1's import gate would have failed
immediately otherwise).

Log: `/tmp/eliza1-smoke-0_8b.log`.

Steps reached:
- **STEP 1/9 deps** — PASS (vLLM installed; apollo_torch, liger_kernel,
  turboquant, transformers all importable).
- **STEP 2/9 SFT** — PASS (200 optimizer steps, full-finetune, APOLLO,
  Liger, FA3, ~10 min on local RTX 5080 mobile 16GB; checkpoint written to
  `packages/training/checkpoints/qwen3-5-0-8b-smoke-fullstack/final/`).
- **STEP 3/9 bench SFT** — PASS (writes
  `packages/training/benchmarks/qwen3-5-0-8b-smoke-fullstack/sft/summary.json`)
  but with `content_pct = 0.0` across all four buckets (response,
  planner_json, tool_call, routing_json).
- **STEP 4/9 PolarQuant** — PASS (4-bit, bench writes summary.json, also
  content_pct=0.0).
- **STEP 5/9 fused-TurboQuant** — **CRASH**:
  `RuntimeError: Smoke test failed: fused forward raised ValueError:
  has_previous_state can only be called on LinearAttention layers, and
  the current Cache seem to only contain Attention layers.`
  This is `fused_turboquant_vendored/hf/fused_cache.py:729`. The vendored
  kernel is incompatible with Qwen3.5's hybrid linear-attention backbone
  (the new "smallest" tier — `full_attention_interval=4`, 6 of 24 layers
  full-attention).
- **STEPS 6-9** — never reached (script exited non-zero at STEP 5).

### Gate 5 verdict

Preflight Gate 5 reads `benchmarks/<key>-smoke-fullstack/sft/summary.json`
and computes `worst_content_pct = min(content_pcts.values())`, fails if
< 80. The smoke produced the file but `worst_content_pct = 0.0`.

I ran preflight directly (`REGISTRY_KEY=qwen3.5-0.8b VAST_GPU_TARGET=h100-1x
bash packages/training/scripts/preflight.sh`) to confirm:

```
[preflight] [5/8] local smoke fresh (<24h, content_pct ≥ 80)
FAIL: smoke content_pct 0.0% < 80.0%
[preflight] FAIL  local smoke missing/stale/red — re-run before paying for Vast
[preflight] FAIL  Fix:  bash scripts/smoke_full_stack.sh
```

`.preflight.ok` was NOT written. `train_vast.sh provision` will refuse
without it.

### Why Gate 5 is unsatisfiable as designed

Gate 5 demands the smoke checkpoint match held-out planner/tool-call/
routing fixtures at ≥ 80 % content fidelity. The smoke trains 200
optimizer steps on a 314-row corpus from a 0.8B base model. There is no
realistic way that 200 SFT steps from a base pretrain reaches 80 %
verbatim match on the structured-output buckets — failing this gate is
the expected outcome of the smoke as currently coded. T17 hit the same
situation (Gate 5 was missing summary file altogether); T18 produced the
summary, which now reveals the gate is also too strict for any smoke.

This is a process / threshold issue for the operator to resolve, NOT a
bug to silently bypass. Two non-bypass options:

1. Re-tune the smoke script's STEP 9 acceptance gate AND
   `ELIZA_PREFLIGHT_MIN_CONTENT_PCT` together — pick a threshold that a
   real 200-step smoke can hit (e.g. 5–10 %). Both numbers should change
   together so the local smoke and the preflight read the same contract.
2. Replace the smoke gate's "content_pct" check with a "structural" check
   (parse_errors == 0, n > 0) — the smoke's job is "does the pipeline run
   end-to-end without crashing and produce parseable output", not "did
   the model converge".

Either change is an explicit operator policy decision — not in T18's
scope.

### Separate issue: fused-TurboQuant on hybrid attention

STEP 5 crash is independent of Gate 5. The vendored fused_turboquant
kernel checks `has_previous_state` on what it believes is a
LinearAttention layer; Qwen3.5 hybrid surfaces 18 standard Attention
layers (out of 24 total, the other 6 are full-attention KV-bearing).
The vendored cache machinery doesn't speak this hybrid layout. Fix path
is upstream: either patch `fused_turboquant_vendored/hf/fused_cache.py`
to gate the `has_previous_state` check on layer type (it should
no-op on standard attention layers), or skip `fused-tq` in the smoke
for hybrid backbones. Out of scope for T18.

## 4. Pre-flight verification — DONE

```
$ bash packages/training/scripts/cloud/dispatch-vast.sh --dry-run --tier 0_8b --gpu h100
[dispatch-vast] === PLAN ===
  provider   : vast.ai
  task       : train   tier: 0_8b
  gpu        : h100    (train_vast token: h100-1x)
  registry   : qwen3.5-0.8b
  cmd        : VAST_GPU_TARGET=h100-1x bash packages/training/scripts/train_vast.sh provision-and-train --registry-key qwen3.5-0.8b --epochs 1
[dispatch-vast] DRY-RUN — no instance provisioned, no charges.

$ RESUME_FROM_CHECKPOINT=checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-1778619044/checkpoint-1000 \
    bash packages/training/scripts/cloud/run-on-cloud.sh --provider vast --task train --tier 0_8b --gpu h100 --dry-run
[run-on-cloud] delegating to train_vast.sh — registry-key=qwen3.5-0.8b gpu-token=h100-1x
[run-on-cloud] DRY-RUN plan:
  VAST_GPU_TARGET=h100-1x bash packages/training/scripts/train_vast.sh provision-and-train --registry-key qwen3.5-0.8b --epochs 1
  (no instance provisioned; no charges)
```

The plan correctly chains `dispatch-vast → train_vast.sh provision-and-train
→ provision → sync_tree → run_remote`. With T18's rsync fix, sync_tree
will now ship `checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-1778619044/checkpoint-1000/`
on the remote, and `run_remote` will append
`--resume-from-checkpoint checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-1778619044/checkpoint-1000`
(T17's existing env-var passthrough at lines 647-650). The teardown
trap is intact (`cleanup() { vastai destroy instance "$INSTANCE_ID" ...}`
in run-on-cloud.sh:255-260 and dispatch-vast.sh:278-283).

## 5. Fire result — DID NOT FIRE

No `nohup ... run-on-cloud.sh ...` issued. Per the brief's CRITICAL
CONSTRAINTS: "DO NOT bypass any preflight gate. If smoke fails or
preflight refuses, abort and report." Both conditions hold (smoke
crashed at STEP 5; preflight refuses at Gate 5). Aborted.

No vast.ai instance was provisioned. No charges incurred.

## 6. 2b — staged, NOT fired

`/tmp/eliza1-train-2b-cmd.txt` updated with the corrected command:
`--gpu h100 --tier 2b --yes-i-will-pay`. T17 incorrectly flagged
`data/final/{train,val,test}.jsonl` as missing for 2b — they are present
(66861/3824/3641 lines) and shared across tiers. The same Gate 5
blocker applies to 2b (the smoke for 2b would also produce
content_pct=0.0). The same fused-turboquant kernel crash applies (2b is
also Qwen3.5 hybrid). Both issues need to be resolved (or accepted via
operator policy) before either tier can fire.

## 7. ETA / cost (unchanged from T17)

- 0_8b APOLLO H100 1× full epoch (with resume from checkpoint-1000): 4-8h wall, ~$2.50/h H100 ⇒ **$10-$20**.
- 2b APOLLO H100 1× full epoch: 6-10h wall ⇒ **$15-$25**.

## 8. Teardown

No instance to destroy. For reference if a future run leaves one running:
```
cat packages/training/scripts/cloud/.run_on_cloud_instance_id  # if present
vastai show instances                                          # all
vastai destroy instance <id>                                   # tear down
```

## 9. Files touched

- `packages/training/scripts/train_vast.sh` — `sync_tree()` now ships
  `RESUME_FROM_CHECKPOINT` (when set) on top of the `checkpoints/` rsync
  exclude. ~14 lines added; no change to the default unset codepath.
- `/tmp/eliza1-train-2b-cmd.txt` — refreshed staged command (h100
  instead of h200, corrected blockers list, cited T18 rsync fix).
- `/tmp/eliza1-smoke-0_8b.log` — smoke log (failed at STEP 5).
- `packages/training/data/smoke` — symlink to `final-eliza1-smoke`
  (local convenience; not committed).
- `reports/eliza1-train-0_8b-fired-2026-05-15.md` — this report.

## 10. What needs to happen next (operator)

1. **Decide Gate 5 contract.** The current `MIN_CONTENT_PCT=80` cannot
   be hit by any 200-step smoke from a 0.8B/2B base model. Either lower
   the threshold (env-var `ELIZA_PREFLIGHT_MIN_CONTENT_PCT=5` or similar)
   AND adjust `smoke_full_stack.sh` STEP 9's `if cnt_pct < 80` to match,
   or replace the gate's content_pct check with a structural one.
2. **Patch fused-turboquant for hybrid attention** (or skip it in the
   smoke for hybrid backbones) so the smoke can reach STEP 9 cleanly.
   File: `packages/training/scripts/quantization/fused_turboquant_vendored/hf/fused_cache.py:729`.
3. **Re-run smoke** with the adjusted gate; verify
   `benchmarks/qwen3-5-0-8b-smoke-fullstack/sft/summary.json` is fresh
   AND `worst_content_pct >= MIN_CONTENT_PCT`. Re-run preflight; verify
   `.preflight.ok` written within current calendar hour.
4. **Fire 0_8b** with the same command T18 would have run:
   ```
   RESUME_FROM_CHECKPOINT=checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-1778619044/checkpoint-1000 \
     nohup bash packages/training/scripts/cloud/run-on-cloud.sh \
       --provider vast --task train --tier 0_8b --gpu h100 --yes-i-will-pay \
       > /tmp/eliza1-train-0_8b-real.log 2>&1 & disown
   ```
5. After 0_8b lands and its `final/` is published, fire 2b from
   `/tmp/eliza1-train-2b-cmd.txt`.
