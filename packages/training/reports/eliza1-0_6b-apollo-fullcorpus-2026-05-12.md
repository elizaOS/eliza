# eliza-1-0_6b — full-corpus APOLLO SFT (2026-05-12, IN FLIGHT)

Follow-up to `reports/eliza1-0_6b-apollo-sft-2026-05-11.md` (the 8k-sample
test-SFT that beat base `Qwen3-0.6B` on every metric but did not clear the
absolute `format_ok` publish floor — that floor is calibrated for a full-corpus
run, which this is).

## 1. Have / need / missing (at launch)

- **Have:** the `qwen3-0.6b` recipe (`scripts/training/model_registry.py` — ChatML,
  seq 4096, `apollo_mini` rank-1, bf16, grad-checkpointing, lr 1e-5, micro_batch 1
  / grad_accum 8); `train_local.py` + `run_pipeline.py` (full chain: SFT → gate
  bench → PolarQuant/QJL/TurboQuant quant → eliza1 sidecar bundle); `.venv` with
  torch 2.11+cu130, transformers 5.7, trl 1.3, Liger (Triton runtime now JIT-works
  on this host — unlike the test-SFT run); the two source corpora
  (`datasets/eliza1-sft-0_6b/{train,val,test}.jsonl` = 1436/71/78 benchmark-aligned
  rows, `data/final/{train,val,test}.jsonl` = 66861/3824/3641 broad-mix rows).
- **Need:** an idle GPU for ~9 GPU-h (turned out ~30 h wall on the 80 W RTX 5080
  Laptop — the combined corpus's `data/final` trajectory rows are ~2.6× longer on
  average than the test-SFT slice, and there are 8.5× as many rows).
- **Missing / blocked:** Nebius H200 — `nebius iam whoami` still hangs on
  browser-SSO federation in this headless context (re-verified at launch), and
  `run-on-cloud.sh --provider nebius` is fail-closed → fell back to the local RTX
  5080. The HF model repo (`elizaos/eliza-1-0_6b`) does not yet exist (PUBLISH
  agent #46 creates it) — so this run stages everything + a manifest for #46.

## 2. Corpus built

`scripts/build_eliza1_fullcorpus.py` → `data/final-eliza1-fullcorpus/` (gitignored):

| split | rows | source order | sha256 |
|---|---:|---|---|
| train | 68,297 | `eliza1-sft-0_6b/train.jsonl` (1,436) AHEAD of `data/final/train.jsonl` (66,861) | `475477b372e17b6d65d0beba3f35e379aa3e08b832ad7f0996ed4681695cb889` |
| val | 3,895 | `eliza1-sft-0_6b/val.jsonl` (71) + `data/final/val.jsonl` (3,824) | `d4fbd5989214509326a12838348231808543b08202382d9370a949dffdbfc30f` |
| test | 3,719 | `eliza1-sft-0_6b/test.jsonl` (78) + `data/final/test.jsonl` (3,641) | `19de77256b48210a3a2dce3d0da282c2aa4f561f4f51df5688f05ce2cf7483d3` |

Every row was run through `format_for_training.format_record` at build time; all
75,911 input rows are train_local-compatible (chat_messages + legacy_eliza_record
shapes). Benchmark-aligned rows go first so the cosine-warmup early steps see the
structured ACTION / tool-call / personality rows the publish gates measure. The
held-out val/test are the merged (larger) sets — they include the benchmark-aligned
rows so the gate bench covers the structured-output buckets.

## 3. SFT run params

```
accelerate launch (1 process) scripts/run_pipeline.py
  --registry-key qwen3-0.6b
  --run-name eliza-1-0_6b-apollo-fullcorpus-1778563093
  --train-file data/final-eliza1-fullcorpus/train.jsonl
  --val-file   data/final-eliza1-fullcorpus/val.jsonl
  --test-file  data/final-eliza1-fullcorpus/test.jsonl
  --epochs 1 --eval-mode full --bench-per-bucket 200
  --skip-base-bench --skip-throughput-bench
```

| param | value |
|---|---|
| base | `Qwen/Qwen3-0.6B` |
| optimizer | `apollo_mini` (rank-1, scale 128, fp32 moments) |
| seq_len / micro_batch / grad_accum | 4096 / 1 / 8 (eff. batch 8) |
| dtype / grad checkpointing / Liger | bf16 / on / **on** (FLCE chunked-CE; Triton JIT works on this host) |
| lr / scheduler / warmup | 1e-5 / cosine / 0.03 |
| epochs / total steps | 1 / 8,538 |
| completion_only_loss | off (Liger active → loss over the full ChatML sequence; chat-template + EOS align targets) |
| GPU | RTX 5080 Laptop (sm_120, 16 GB, 80 W cap) |
| step rate | ~12.7 s/it ⇒ ~30 h wall |
| log | `packages/training/checkpoints_run_eliza-1-0_6b-apollo-fullcorpus-1778563093.log` |
| output dir | `packages/training/checkpoints/eliza-1-0_6b-apollo-fullcorpus-1778563093/` |

Status at last checkpoint of this report: ~step 500/8538, loss ~22 → ~11 through
the LR warmup, then plateauing ~10–12 around LR 1e-5 (grad_norm 40–140, clipped).
First mid-run eval (step 500 over the 3,895-row val set) was running. **Train loss
~11 is high vs the test-SFT's eval_loss 1.315** — but the test-SFT was 1 full epoch
over 8k rows; this run is at 0.06 epoch. Watch the step-500/1000/… `eval_loss`: if
it does not fall toward ≲2 by ~epoch 0.3–0.5, the recipe needs more LR or 2 epochs
(see §6).

## 4. GPU coordination outcome

GPU was idle (4 MiB, 0 %) at launch — the CUDA-FINISH agent (#39) had finished its
verify/build runs. No poll-wait was needed. Nebius H200 not used (headless auth
unavailable, re-verified). Trade-off accepted: this run monopolizes the RTX 5080
for ~30 h; #39 and any other GPU job must queue behind it (or kill it — see resume
command below).

## 5. Resume / monitor (run is mid-flight)

Monitor:
```bash
tail -f packages/training/checkpoints_run_eliza-1-0_6b-apollo-fullcorpus-1778563093.log | tr '\r' '\n'
nvidia-smi
```

If killed and you need to restart from scratch (no resumable checkpoint was
requested — `--save-steps 500 --save-total-limit 3` writes `checkpoint-N/` dirs
under the output dir, so `accelerate launch … --resume_from_checkpoint <dir>` is
possible if the run is interrupted; otherwise re-launch the §3 command). If an
operator has fixed Nebius headless auth, the H200 alternative is:
```bash
NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec HUGGING_FACE_HUB_TOKEN=<hf> \
REGISTRY_KEY=qwen3-0.6b \
bash packages/training/scripts/cloud/run-on-cloud.sh --provider nebius --task train --gpu h200 --tier 0_6b --yes-i-will-pay
```
(point its `--train-file`/`--val-file`/`--test-file` at the
`data/final-eliza1-fullcorpus/` splits, or rebuild them remotely with
`scripts/build_eliza1_fullcorpus.py` after rsyncing both source corpora).

## 6. What happens at completion (run_pipeline.py auto-chains)

1. `final/` HF safetensors + tokenizer + `chat_template.jinja` saved.
2. Stage 3: post-train bench (`eliza_bench.py` + `native_tool_call_bench.py`,
   `--eval-mode full`, 200/bucket) → `benchmarks/<run>/finetuned/`.
3. Stage 4: `evals/aggregate.json` + `gate_report.json` — **check `format_ok` ≥
   0.70** (the `0_6b` `format_ok` gate in `benchmarks/eliza1_gates.yaml`,
   `required: true, provisional: false`).
4. Stage 5: PolarQuant + fused-TurboQuant + QJL quant against the new `final/`.
5. Stage 6b: eliza1-typed GGUF bundle via `optimize_for_eliza1.py` (Q4_POLAR
   weights sidecar + QJL1_256 K-cache + TBQ V-cache + `eliza1_manifest.json`),
   plus the Q4_K_M GGUF (`final-gguf-q4_k_m/`).
6. **If `format_ok` clears 0.70:** re-run `scripts/quantization/gguf_eliza1_apply.py`
   against `final/` if the bundle stage didn't already, then — if `elizaos/eliza-1-0_6b`
   exists — push `final/` + Q4_K_M GGUF + the eliza1 sidecar bundle there
   (`HF_TOKEN` env), model card → "full-corpus APOLLO SFT, clears the format_ok
   gate"; update `benchmarks/MODELS_STATUS.md` + release evidence. If the repo
   doesn't exist, stage + manifest for PUBLISH #46.
7. **If `format_ok` does NOT clear 0.70:** keep the checkpoint, document the gap
   (train loss plateau ⇒ try lr 2e-5 or 2 epochs; or a data-mix tweak — the
   `data/final` rows dominate 49:1 over the benchmark-aligned rows, so upsample
   `eliza1-sft-0_6b` 5–10× if format coverage is the gap), and recommend the next
   step rather than publishing.

Side-by-side table (base vs test-SFT vs full-corpus) to be filled in once Stage 4
lands — the base + test-SFT columns are in
`reports/eliza1-0_6b-apollo-sft-2026-05-11.manifest.json::benchmark_table`.

## 7. Next step

The full-corpus SFT is running on the RTX 5080 (~30 h ETA from 2026-05-12 ~22:20
UTC start). When it finishes, `run_pipeline.py` produces the gate report and the
quant bundle automatically; whoever picks this up should read
`checkpoints/eliza-1-0_6b-apollo-fullcorpus-1778563093/gate_report.json`, fill in
the §6 table, and either publish (gate green) or iterate (gate red, per §6.7).

Progress check (2026-05-12 ~02:00 UTC): step ~960/8538 (~11 %), loss plateau
~10–12 around LR 1e-5, mid-run `eval_loss` 1.43 at step 500 (vs the test-SFT's
final 1.315 — on track; this run is still <0.1 epoch in).

## 8. Corpus addendum — structured_decode + voice_emotion tasks (2026-05-12, WS-3)

The combined corpus this run trains on (`data/final-eliza1-fullcorpus/`) was
built *before* the cross-cluster corpus additions landed, so it does **not**
contain explicit Stage-1 response-envelope rows or voice-emotion rows. After
this run, `build_eliza1_sft_0_6b.py` has been extended (commit on `develop`
2026-05-12) with two new task generators:

- `structured_decode` — the W3 flat JSON response envelope `@elizaos/core`
  `buildResponseGrammar` constrains (`{"shouldRespond":"RESPOND|IGNORE|STOP",
  "thought":...,"replyText":...,"contexts":[...],"contextSlices":[...],
  "candidateActions":[...],"parentActionHints":[...],"requiresTool":<bool>,
  "extract":{...}}`; `shouldRespond` dropped on direct DM/voice/API channels),
  key order matching `packages/core/src/runtime/response-grammar.ts::
  STAGE1_ENVELOPE_KEYS`. On-wire form is JSON (not "TOON"), matching the
  runtime model call. Deterministic seed rows + Cerebras `gpt-oss-120b`
  augmentation. ~250 rows in `datasets/eliza1-sft-0_6b/train.jsonl`.
- `voice_emotion` — spoken replies with omnivoice-singing inline expressive
  tags in `replyText` (`[happy]` `[sad]` `[angry]` `[nervous]` `[calm]`
  `[excited]` `[whisper]` `[singing]` + non-verbals `[laughter]` `[sigh]`).
  ~245 rows.

**If this run's `format_ok` clears 0.70** → publish as planned (§6.6); the
augmented corpus is the *next* iteration's improvement, not a blocker.
**If it falls short** → the iteration is: rebuild the combined corpus from the
*new* `eliza1-sft-0_6b` (now with the envelope rows that `format_ok` actually
measures — the test-SFT mix never emitted the envelope at all, which is why
`format_pct` was 0%), upsample `eliza1-sft-0_6b` 5–10× over `data/final`, and
re-run (locally or on the H200 — see §9). The full-corpus run on the H200 was
not launched this session because (a) the in-flight RTX-5080 run is healthy and
11 % done, (b) `train_vast.sh`'s `run_remote` hardcodes
`--fsdp_transformer_layer_cls_to_wrap Qwen3_5DecoderLayer` (the 0.6b/1.7b tiers
are `Qwen3DecoderLayer`) and rsyncs only `data/final/` (not the combined
corpus), and (c) `train_nebius.sh` is written against an older `nebius compute
instance create` flag set (`--project-id` / `--boot-disk-spec`; the current CLI
wants `--parent-id` / `--resources-platform` / `--boot-disk-*`). Both cloud
credentials (vast `VAST_API_KEY`, nebius federation token) are present and the
CLIs authenticate (`vastai show instances`, `nebius iam tenant list` both
succeed) — the gap is the orchestration-script update + a babysat run window,
not the creds.

## 9. H200 run — exact resume (when an operator can babysit it)

```bash
# Option A — Nebius (after patching train_nebius.sh to the current CLI):
NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec HUGGING_FACE_HUB_TOKEN=<hf> \
REGISTRY_KEY=qwen3-0.6b NEBIUS_VM_PRESET=gpu-h200x1 FSDP_WORLD_SIZE=1 \
bash packages/training/scripts/cloud/run-on-cloud.sh --provider nebius --task train --gpu h200 --tier 0_6b --yes-i-will-pay
# Then on the remote box rebuild the combined corpus before training:
#   uv run python scripts/build_eliza1_fullcorpus.py
#   (and point train at data/final-eliza1-fullcorpus/{train,val,test}.jsonl)

# Option B — Vast (canonical; fix the FSDP wrap class + corpus rsync first, or
# run train_local.py directly inside tmux on the remote):
VAST_API_KEY=<key> ELIZA_VAST_MAX_USD=30 \
bash packages/training/scripts/train_vast.sh provision-and-train --registry-key qwen3-0.6b --epochs 3
```

## 10. H200 run launched (2026-05-12 ~10:30 UTC) — `train_nebius.sh` rewritten

The operator re-authenticated Nebius. `scripts/train_nebius.sh` was rewritten
against the live `nebius` CLI v0.12 (`instance create` now wants `--parent-id`
/ `--resources-platform gpu-h200-sxm` / `--resources-preset 1gpu-16vcpu-200gb`
/ an *existing* boot disk created from the `mk8s-worker-node-v-1-31-ubuntu24.04-cuda12.8`
public image / a real subnet / ssh keys via `--cloud-init-user-data`). A cheap
CPU-instance smoke (`bash scripts/train_nebius.sh smoke`) verified the
provision→ssh→teardown path. Then the 0_6b full-corpus run was launched:

- VM: `eliza-train-h200-0_6b` (`computeinstance-e00zzb9z10n4jpr11z`), NVIDIA
  H200 (141 GB), driver 570.211.01 / CUDA 12.8.
- Corpus: `data/final-eliza1-fullcorpus/` rebuilt **on the H200** from the
  current `datasets/eliza1-sft-0_6b/` (which now *does* contain the
  `structured_decode` + `voice_emotion` envelope rows the `format_ok` gate
  measures) + `data/final/`, with **`ELIZA1_FULLCORPUS_UPSAMPLE=8`** — the
  benchmark-aligned slice (1257 valid train rows) is repeated 8× to fight the
  ~49:1 dilution by the broad mix. Result: train 76 917 / val 3 909 / test
  3 700 rows. The combined corpus mixes ChatML (`{"messages":[...]}`) rows,
  which `validate_corpus.py` (a *native-record* schema validator) can't parse,
  so the run uses `--allow-unvalidated-corpus` (the build-time
  `format_for_training.format_record` gate vets every row). The in-flight
  RTX-5080 run (§7, run `eliza-1-0_6b-apollo-fullcorpus-1778563093`) is **not**
  using the upsampled corpus and lacks the envelope rows — so this H200 run is
  the candidate to clear `format_ok ≥ 0.70`; the local run continues for now as
  a fallback and is **superseded** if the H200 run clears the gate.
- torch fix: the project pins torch 2.11+cu130, which needs driver ≥580 — too
  new for the Nebius image's 570.x. `train_nebius.sh`'s remote runner detects
  `torch.cuda.is_available()==False` and swaps to **torch 2.11.0+cu128**
  (ABI-compatible with liger/bitsandbytes/apollo), removing the leftover cu13
  nvidia stack and force-refreshing `nvidia-cusparselt-cu12`.
- `run_pipeline.py` chain on the H200: corpus gate (warn-only) → base bench
  (`native_tool_call_bench.py` + `eliza_bench.py`, 200/bucket — note: these
  bench scripts run the 0.6B *on CPU* in this env, ~30 min) → APOLLO full-SFT
  on the GPU (1 epoch, lr 1e-5, seq 4096, Liger) → `gate_report.json` → PolarQuant
  + fused-TurboQuant + QJL quant → eliza1-typed GGUF bundle. Results fetched to
  `checkpoints/<run>/` + `benchmarks/<run>/` + `reports/`, then VM+disk torn down.
- Resume / monitor: `tmux attach -t elizatrain` on the VM (ssh `ubuntu@<vm-ip>`,
  `bash scripts/train_nebius.sh ip`); log `/opt/training/run_<run-name>.log`.
  Re-launch from scratch:
  ```bash
  NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec HUGGING_FACE_HUB_TOKEN=<hf> HF_TOKEN=<hf> \
  REGISTRY_KEY=qwen3-0.6b NEBIUS_VM_PRESET=gpu-h200x1 SYNC_FULLCORPUS_SOURCES=1 \
  ELIZA1_FULLCORPUS_UPSAMPLE=8 ALLOW_UNVALIDATED_CORPUS=1 \
  TRAIN_FILE=data/final-eliza1-fullcorpus/train.jsonl VAL_FILE=data/final-eliza1-fullcorpus/val.jsonl TEST_FILE=data/final-eliza1-fullcorpus/test.jsonl \
  RUN_NAME=eliza-1-0_6b-apollo-fullcorpus-h200-$(date +%s) NEBIUS_VM_NAME=eliza-train-h200-0_6b \
  bash packages/training/scripts/train_nebius.sh full
  ```
  (or the granular `provision` / `sync` / `run` / `fetch` / `teardown` steps —
  the corpus is ~1 GB and the Nebius eu-north1 uplink is ~3.4 Mbps, so prefer
  `scp`-ing a `tar czf` of `data/final/{train,val,test}.jsonl` +
  `datasets/eliza1-sft-0_6b/{train,val,test}.jsonl` into `/opt/training/` before
  `sync`, which then matches & skips).
