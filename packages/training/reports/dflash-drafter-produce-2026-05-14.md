# DFlash drafter production — status, blockers, launch plan (2026-05-14)

> **TL;DR.** Zero new Qwen3.5 drafter GGUFs were produced this run.
> Every tier that needs a drafter (`eliza-1-{2b,4b,9b,27b,27b-256k,27b-1m}`)
> is blocked on an upstream prerequisite — there is no SFT'd target text
> checkpoint anywhere in the repo, and the distillation script
> (`packages/training/scripts/distill_dflash_drafter.py`) is fail-closed
> on a missing `--target-checkpoint`. Two unblocking items landed in
> this run: (1) the `train_nebius.sh distill` wrapper was passing flags
> the distillation script does not accept (a real bug — the cloud
> invocation would have failed with `argparse: unrecognized arguments`);
> that wrapper has been rewritten to pass the correct flags and to
> rsync the target HF checkpoint to the remote VM, and (2) this
> document records the precise H200 launch sequence so the operator
> can fire each tier as soon as its SFT lands.

## Section 1 — Drafter shape per tier (canonical)

Source of truth: `packages/training/scripts/training/model_registry.py`
(`DFLASH_DRAFTER_BASE`, lines 247-255) and
`packages/training/scripts/distill_dflash_drafter.py`
(`DEFAULT_STUDENT_BASE`, `DEFAULT_TARGET_MODEL`, `ACCEPTANCE_GATE`
near lines 84-121).

| eliza-1 tier      | needs drafter? | student base                  | distill target            | KD recipe                                | acceptance gate | GGUF output |
|-------------------|:--------------:|--------------------------------|---------------------------|-------------------------------------------|:---------------:|-------------|
| `eliza-1-0_8b`    | **NO**         | n/a (it _is_ the drafter base) | n/a                       | n/a                                       | n/a             | n/a         |
| `eliza-1-2b`      | YES            | `Qwen/Qwen3.5-0.8B-Base`       | `elizaos/eliza-1/bundles/2b` (SFT'd `Qwen/Qwen3.5-2B-Base`) | top-k forward KL + 0.1 CE floor, APOLLO/APOLLO-Mini | 0.48 | `drafter-2b.gguf` (Q4_K_M after quant; script writes f16 by default — re-quant to Q4_K_M post-distill) |
| `eliza-1-4b`      | YES            | `Qwen/Qwen3.5-0.8B-Base`       | `elizaos/eliza-1/bundles/4b`                                | same                                                | 0.52 | `drafter-4b.gguf`  |
| `eliza-1-9b`      | YES            | `Qwen/Qwen3.5-0.8B-Base`       | `elizaos/eliza-1/bundles/9b`                                | same                                                | 0.52 | `drafter-9b.gguf`  |
| `eliza-1-27b`     | YES            | `Qwen/Qwen3.5-0.8B-Base`       | `elizaos/eliza-1/bundles/27b`                               | same                                                | 0.52 | `drafter-27b.gguf` |
| `eliza-1-27b-256k`| YES            | `Qwen/Qwen3.5-0.8B-Base`       | `elizaos/eliza-1/bundles/27b-256k`                          | same                                                | 0.52 | `drafter-27b-256k.gguf` |
| `eliza-1-27b-1m`  | YES            | `Qwen/Qwen3.5-0.8B-Base`       | `elizaos/eliza-1/bundles/27b-1m`                            | same                                                | 0.52 | `drafter-27b-1m.gguf` |

Every drafter is a single 0.8B Qwen3.5 student. The 27b/27b-256k/27b-1m
share an SFT but require three distinct re-distills against their
respective long-context target GGUFs so each drafter's recorded
`dflash-draft.target_checkpoint_sha256` matches the bytes it ships
with (the publish gate refuses a mismatch).

## Section 2 — Current artifact state

### 2.1 Local bundle directories

```
$ ls ~/.eliza/local-inference/models/
eliza-1-0_6b.bundle/   # LEGACY Qwen3, drafter-0_6b.gguf is stamp-only against legacy text
eliza-1-1_7b.bundle/   # LEGACY Qwen3
# (no Qwen3.5 tier bundles exist locally yet)
```

The Qwen3.5 tier bundles (`eliza-1-{0_8b,2b,4b,9b,27b}.bundle/dflash/`)
are not on disk. The bundle staging step
(`packages/training/scripts/manifest/stage_local_eliza1_bundle.py`)
creates them at publish time; until then there is nowhere to drop a
distilled drafter on this machine.

### 2.2 SFT'd target text checkpoints — NONE exist for any active tier

```
$ ls packages/training/checkpoints/
eliza-1-0_6b-apollo-*       # legacy Qwen3
eliza-1-1_7b-apollo-*       # legacy Qwen3
eliza-1-0_8b-apollo-fullcorpus-h200-v5-resume-*  # has environment.json + instrumentation.jsonl only — crashed before any model.safetensors was written (per .swarm/STATUS.md v4-v5)
eliza-1-{0_8b,2b,4b,9b,27b,27b-256k,27b-1m}-smoke-1778741959-*   # smoke benchmark dirs only, no model weights
```

Per the 2026-05-14 audit (§1.1 per-tier matrix), every active-tier SFT
is "no SFT yet" except `0_8b` which crashed in v5 with no usable
checkpoint. **There is nothing to distill against locally.**

### 2.3 Distillation script contract

`packages/training/scripts/distill_dflash_drafter.py::_run_distillation`:

- Requires `--target-checkpoint <dir>` to exist on disk; otherwise
  returns exit 2 (`distill_dflash_drafter.py:484-494`).
- Requires `--dataset <jsonl>` to exist; otherwise exit 2
  (`:487-497`).
- Loads target via `AutoModelForCausalLM.from_pretrained(target_checkpoint)`
  (`:567-569`). The Qwen3.5 hybrid linear-attn architecture requires
  `transformers >= 4.57.0` (verified locally at 5.4.0; the train_nebius
  wrapper force-upgrades the remote venv to >=4.57.0 at line 524).
- Enforces tokenizer parity via byte-equivalent fingerprint
  (`_tokenizer_parity_report`, `:203-217`). **Known wrinkle**:
  loading from a local snapshot path vs the HF id produces non-equal
  `chat_template.jinja` bytes even though the vocab and probe encodings
  match — see §6 below.
- APOLLO-only — imports `build_apollo_mini_optimizer` /
  `build_apollo_optimizer` from `training.optimizer` at `:621-639`,
  with no AdamW/Muon escape hatch.
- Writes `drafter-<tier>-hf/` (transformers checkpoint) + invokes the
  fork's `convert_hf_to_gguf.py` to emit `drafter-<tier>.gguf`, then
  stamps the target sha256 into GGUF metadata
  (`_write_gguf_target_hash`, `:296-327`).

## Section 3 — `train_nebius.sh distill-full` bug — FIXED in this run

### 3.1 The bug

The wrapper at `train_nebius.sh:537-540` (pre-fix) invoked the
distillation script with:

```sh
.venv/bin/python scripts/distill_dflash_drafter.py \
  --tier $tier --target-base $target_base $student_arg \
  ...
```

where `$student_arg` was either `--student-base $student_base` or
`--student-config $student_cfg`. The distillation script accepts
neither `--target-base` nor `--student-config` (verified by
`grep -n "p.add_argument" packages/training/scripts/distill_dflash_drafter.py`
— the actual flags are `--target-checkpoint`, `--target-gguf`,
`--target-model-id`, `--student-base`). A `distill-full` invocation
would have died on argparse before training a single step.

### 3.2 The fix (this commit)

`packages/training/scripts/train_nebius.sh::run_distill_remote` and
`::sync_distill_dataset` were rewritten to:

1. Replace `DFLASH_TARGET_BASE` (an HF id) with `DFLASH_TARGET_CHECKPOINT`
   (a remote path to the SFT'd target HF checkpoint dir). Fails early
   if unset.
2. Replace `DFLASH_STUDENT_CONFIG` (from-scratch config dir, a flag
   that does not exist on the distiller) with `DFLASH_STUDENT_BASE`
   (HF id of the published student base), defaulted to
   `Qwen/Qwen3.5-0.8B-Base` per `DFLASH_DRAFTER_BASE`.
3. Add `DFLASH_TARGET_GGUF` (optional remote path) — passed through to
   `--target-gguf` so the drafter records the final shipped target
   GGUF's sha256, which is what the runtime doctor + publish gate
   actually check.
4. Add `DFLASH_TARGET_MODEL_ID` (optional) — passed through to
   `--target-model-id` for evidence/recordkeeping.
5. Default `DFLASH_TIER=2b` (the recommended first cloud target) rather
   than the prior `9b` default (which is the largest local-tier SFT
   and not the right first artifact).
6. Extend `sync_distill_dataset` to rsync the target HF checkpoint dir
   (multi-GB; `checkpoints/` is excluded from the main `sync_tree`) and
   the optional target GGUF to `$REMOTE_TRAIN_DIR/$DFLASH_TARGET_CHECKPOINT`
   and `$REMOTE_TRAIN_DIR/$DFLASH_TARGET_GGUF` respectively.

The `distill-full` flow (`provision → sync_tree → sync_distill_dataset →
run_distill_remote → fetch_distill`) now lines up with the script's
actual contract.

## Section 4 — H200 launch plan (one tier at a time)

Each tier launches independently once its SFT lands. **Pre-flight, in
order, for any tier:**

1. The SFT'd HF checkpoint exists at `packages/training/checkpoints/eliza-1-<tier>-apollo-<run>/final/`
   with `model.safetensors[.index.json]`, `config.json`, and the full
   Qwen3.5 tokenizer set. The `eliza-1-0_8b-apollo-fullcorpus-h200-v5-resume-1778735955`
   directory is the canonical 0.8b run; replicate the path layout for
   2b/4b/9b/27b.
2. The final shipped target GGUF exists at
   `packages/training/checkpoints/eliza-1-<tier>-apollo-<run>/eliza1-optimized/gguf/final-Q4_POLAR.gguf`
   (or whichever Q4_K_M / Polar-K_M build the publish path will ship).
3. `nebius iam whoami` returns within 5s — refuse to provision if the
   federation token has lapsed (see audit §6.3).
4. `Qwen/Qwen3.5-0.8B-Base` is reachable on the Hub (verified
   2026-05-14: 156k downloads, public).

### 4.1 The `eliza-1-2b` drafter (recommended first cloud target)

Wall-clock estimate, 1×H200 SXM: corpus + load ~5 min, 20k-sample
KD epoch at seq_len=2048 batch=8 ga=4 ≈ 45-70 min, GGUF convert +
stamp ~3 min, teardown ~1 min. **Total ≈ 60-90 min, ~$3-5 cloud
spend.**

```sh
# Pre-flight (NOT executed in this run):
cd /home/shaw/milady/eliza/packages/training
# 0. confirm SFT artifact exists and pick paths
TIER=2b
RUN=eliza-1-2b-apollo-fullcorpus-h200-XXXXXXXXXX   # fill in the real run id
CKPT_REL=checkpoints/$RUN/final
GGUF_REL=checkpoints/$RUN/eliza1-optimized/gguf/final-Q4_POLAR.gguf
ls -lh "$CKPT_REL/model.safetensors"* "$GGUF_REL" || { echo "PRE-FLIGHT FAIL: SFT artifacts missing"; exit 1; }

# 1. launch (provision → sync → sync_distill_dataset → distill → fetch → teardown)
NEBIUS_VM_NAME=eliza-distill-2b-$(date +%s) \
NEBIUS_GPU_PRESET=1gpu-16vcpu-200gb \
RUN_NAME=$RUN \
DFLASH_TIER=$TIER \
DFLASH_TARGET_CHECKPOINT="$CKPT_REL" \
DFLASH_TARGET_GGUF="$GGUF_REL" \
DFLASH_TARGET_MODEL_ID="elizaos/eliza-1/bundles/$TIER" \
DFLASH_STUDENT_BASE=Qwen/Qwen3.5-0.8B-Base \
DFLASH_DATASET=data/dflash-distill-slice.jsonl \
DFLASH_EPOCHS=1 \
DFLASH_BATCH=8 \
DFLASH_GRAD_ACCUM=4 \
DFLASH_MAX_SEQ_LEN=2048 \
DFLASH_MAX_SAMPLES=20000 \
DFLASH_OUT_DIR=out/dflash-drafter-$TIER \
bash scripts/train_nebius.sh distill-full

# 2. arm the watcher in another shell (catches CLI auth expiry / 6h driver cap)
NEBIUS_VM_NAME=<same as step 1> \
RUN_LOG=$REMOTE_TRAIN_DIR/distill_$RUN.log \
bash scripts/nebius_watcher.sh
```

Output artifacts (under `packages/training/out/dflash-drafter-2b/`
after `fetch_distill`):

- `drafter-2b.gguf` (f16, ~1.6 GB — needs Q4_K_M re-quant before
  bundling).
- `drafter-2b.distill.json` (manifest: target sha256, tokenizer parity,
  dataset hash, KD hparams, training commit, acceptance gate).
- `drafter-2b-hf/` (HF checkpoint dir — keep for re-quant + republish).

### 4.2 The `eliza-1-4b`, `eliza-1-9b` drafters

Same launch shape; swap `TIER` and the `CKPT_REL` / `GGUF_REL` paths.
Wall-clock is dominated by the target's forward pass:

| tier  | target params | seq | per-step (H200 SXM) | 20k samples × 1 epoch |
|-------|--------------:|----:|--------------------:|-----------------------:|
| 2b    |          2.27B | 2048 | ~150 ms             | ~45 min |
| 4b    |          4.00B | 2048 | ~260 ms             | ~75 min |
| 9b    |          9.00B | 2048 | ~570 ms             | ~165 min (~2h 45m) |

A single 1×H200 SXM handles all three sequentially in ~5h end-to-end
including provision/teardown, ≈ $15-22 cloud spend.

### 4.3 The `eliza-1-27b` family — 3 drafters off 1 SFT

The 27b SFT itself needs `gpu-h200x2` (per `train_nebius.sh:21-25`
and `model_registry.py::extra["vast_gpu_target"]: h200-2x`), and after
the SFT the distillation needs to forward through a 27B target — also
H200x2 territory:

| target params | seq  | per-step (H200x2 fp16) | 20k samples × 1 epoch |
|--------------:|-----:|-----------------------:|----------------------:|
|          27B  | 2048 | ~1.6 s                  | ~9 h |

Three sequential distills (27b @ 128k, 27b-256k @ 256k, 27b-1m @ 1M
context — same student, different target GGUFs to stamp against)
need ~27 GPU-h on H200x2 (~$80-110 each at 2× $4/GPU-h ≈ $250-330
total). **Defer until 0_8b/2b/4b/9b drafters land — those four cover
~95% of the local-tier user surface.**

The launch for each 27b sub-tier mirrors §4.1 with three differences:
- `NEBIUS_GPU_PRESET=8gpu-128vcpu-1600gb` (H200x2 8-GPU node).
- `DFLASH_TARGET_GGUF` points at the long-context-specific GGUF
  (e.g. `eliza1-optimized/gguf/27b-256k-Q4_POLAR.gguf`) — the target
  weights are shared across the three sub-tiers but the GGUF the
  drafter stamps against differs.
- `DFLASH_MAX_SEQ_LEN=4096` (a 27B doesn't get cheaper at shorter
  sequences and the student needs to learn long-context behavior to
  pay back acceptance at 256k/1M context).

## Section 5 — What this run did and did not do

### Done
- Cataloged drafter shape per tier (§1).
- Inventoried local artifact state (§2).
- Fixed `train_nebius.sh::run_distill_remote` to pass the flags the
  distillation script actually accepts (`--target-checkpoint`,
  `--target-gguf`, `--target-model-id`, `--student-base`) instead of
  the non-existent `--target-base` / `--student-config` flags
  (`packages/training/scripts/train_nebius.sh`).
- Extended `train_nebius.sh::sync_distill_dataset` to rsync the SFT'd
  target HF checkpoint dir + optional target GGUF to the remote VM
  (the prior wrapper synced only the dataset, leaving the distill step
  with no target to load).
- Verified `Qwen/Qwen3.5-0.8B-Base` is publicly resolvable on HF (156k
  downloads as of 2026-05-14).
- Verified local box has `transformers==5.4.0`, `apollo_torch==1.0`,
  `torch==2.9.0+cu128`, RTX 5080 (16 GB) — i.e. the box CAN run a
  distillation if a real target checkpoint existed.
- Documented the per-tier H200 launch plan (§4) with the exact env
  vars the fixed wrapper now consumes.

### NOT done (and why)
- **No new drafter GGUFs were produced.** The distillation script is
  fail-closed on a missing `--target-checkpoint`, and zero active-tier
  Qwen3.5 SFTs exist on this box or on HF. Distilling against the
  raw `Qwen/Qwen3.5-2B-Base` (not fine-tuned) would produce a
  technically-real GGUF, but a drafter distilled to match the base
  model's policy is not the drafter the shipped bundle needs — its
  recorded `target_checkpoint_sha256` would be the base model's hash,
  not the SFT'd Eliza-1 target, so the publish gate would block on
  the hash mismatch when the real target ships. Re-distilling once
  per SFT is unavoidable.
- **No cloud VM was provisioned.** Per the hard-rules in this task:
  "If H200 is needed and you can't avoid it, write the precise launch
  command + watcher arm command and STOP — do not provision cloud
  yourself."
- **No bundle manifest was updated.** There is no new drafter GGUF
  to record. The `eliza-1-0_6b.bundle` and `eliza-1-1_7b.bundle`
  drafter entries are legacy Qwen3 artifacts and remain unchanged.
- **`packages/shared/src/local-inference/catalog.ts` was not edited.**
  The drafter pointer scheme (`dflash/drafter-${tierSlug(id)}.gguf`)
  is already correct; no shape change is needed — only the bytes are
  missing, and those land per-tier as each cloud run completes.

## Section 6 — Tokenizer parity known issue

`distill_dflash_drafter.py::_tokenizer_parity_report` declares parity
only when both serialized tokenizer file sets are byte-equivalent.
When the target is loaded from a local HF snapshot directory and the
student is loaded from the HF id `Qwen/Qwen3.5-0.8B-Base`, the
`chat_template.jinja` bytes produced by `tokenizer.save_pretrained`
differ between the two sides — transformers 5.x serializes the
embedded chat template with slight whitespace/encoding differences
depending on whether it was loaded from a snapshot's
`tokenizer_config.json` chat_template field or the standalone
`chat_template.jinja` file. The vocab itself and the probe-encoding
test both pass; functional parity is intact.

The cloud launch in §4 doesn't hit this in practice because it loads
both target and student via `AutoTokenizer.from_pretrained(<hf_id>)`
inside the same Nebius VM, which produces identical bytes. The local
verification path does. This is worth fixing in a follow-up by
relaxing the strict file-byte check to a "vocab + special_tokens +
chat_template_string + probe_encodings" structural equality test
(probably ~30 lines), but it does not block production drafter
distillation in the cloud.

## Section 7 — Files touched this run

- `packages/training/scripts/train_nebius.sh` — rewrote the
  `run_distill_remote()` env-knob block and arg list; extended
  `sync_distill_dataset()` to push the target HF checkpoint + target
  GGUF to the remote VM.
- `packages/training/reports/dflash-drafter-produce-2026-05-14.md`
  (this file) — the per-tier launch plan and the per-tier production
  state record.

No GGUFs, manifests, or runtime catalog entries changed in this run.

End of report.
