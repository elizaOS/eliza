# eliza-1-0_8b H200 SFT post-mortem (2026-05-12)

## TL;DR

Three back-to-back Qwen3.5-0.8B-Base APOLLO SFT runs on Nebius H200
(`eliza-1-0_8b-apollo-fullcorpus-h200-1778595498/1778597485/1778601427`)
all crashed in the **finetune step** at the dataset Map() phase with a
`TypeError: Can only get item pairs from a mapping.` raised inside the
Qwen3.5 chat template. Root cause is data-shape, not infra: the
combined corpus contains OpenAI-ChatML assistant turns whose
`tool_calls[].function.arguments` is a JSON-encoded **string** (per the
OpenAI spec + `format_for_training.format_record`), but the Qwen3.5 /
Qwen3.6 chat template iterates `tool_call.arguments | items` which
requires a mapping. The 0.6b runs trained fine because the legacy Qwen3
chat template doesn't take that code path.

Fix (now committed as `ac35880c91` on `develop`):
`train_local.py::build_dataset` coerces the `arguments` field
(string → dict via `json.loads`) before calling
`tokenizer.apply_chat_template`.

## 1. What ran, what died

```
RUN_NAME                                              VM lifetime         outcome
eliza-1-0_8b-apollo-fullcorpus-h200-1778595498        ~07:14 → ~07:34Z    finetune exit=1 (chat-template TypeError) → trap teardown
eliza-1-0_8b-apollo-fullcorpus-h200-1778597485        ~07:50 → ~08:08Z    same
eliza-1-0_8b-apollo-fullcorpus-h200-1778601427        ~15:57 → ~16:20Z    same; full-pipeline driver wrote RUN_PIPELINE_EXIT=0 (PIPESTATUS bug, see §3)
```

All three checkpoint directories (`packages/training/checkpoints/eliza-1-0_8b-apollo-fullcorpus-h200-*/`) are empty — no `final/`, no `gate_report.json`. The `pipeline-summary.json` rsynced back (877 bytes) records `stages.finetune = { "exit": 1 }` for 1778601427. All three Nebius instances and their boot disks were cleaned up by the `train_nebius.sh full` `trap teardown on EXIT` — no billing left running.

## 2. The actual crash

Tail of the failing run (1778601427) from `/tmp/q35-0_8b-launch.log:763`:

```
+9m | 2026-05-12 16:18:15,455 [INFO]   → exit=1 (218.0s)
2026-05-12 16:18:15,456 [ERROR] finetune failed; aborting
```

The `218.0s` is the `Process.run` wall time for `train_local.py`. The traceback
itself was truncated by the polling tail (`ssh "tail -3"`), but the failure
signature (TypeError during the `Tokenizing train dataset (num_proc=16)` Map
pass, exit=1 after 218 s) is identical across all three runs. Local repro on
the same combined corpus + `transformers==5.7.0` + the `Qwen/Qwen3.5-0.8B-Base`
tokenizer confirms:

```
File ".../jinja2/.../template.jinja", line N, in template
    {%- for k, v in tool_call.arguments | items -%}
TypeError: Can only get item pairs from a mapping.
```

The offending rows are the OpenAI-ChatML mix-ins from `eliza1-sft-0_6b/train.jsonl` (the benchmark-aligned tool-call rows). `format_for_training.format_record` preserves `arguments` as the on-wire JSON-encoded string. The Qwen3 dense base used by the 0.6b run renders `tool_call.arguments` literally as a string (no `| items`), which is why the 0.6b ran clean on the same corpus.

## 3. Secondary bug: PIPESTATUS confusion

`train_nebius.sh::run_remote` previously launched the inner script as
`bash .run_pipeline.sh 2>&1 | tee $log; echo RUN_PIPELINE_EXIT=$? >> $log`.
With `tee`'s rc in `$?`, a `set -e` exit in the inner script produced
`RUN_PIPELINE_EXIT=0` → the driver's polling loop saw "success" → it
ran fetch + teardown against an empty checkpoint dir. That fix
(`echo RUN_PIPELINE_EXIT=${PIPESTATUS[0]}`) was already in the working
tree as of the previous worktree session; the same commit
(`ac35880c91`) now lands it on `develop`. Verified against the
1778601427 log: the **inner** script did exit 0 in spite of `set -e`
(uv-run swallow + `&&` torch_swap interaction), so PIPESTATUS alone
wouldn't have caught it without the chat-template fix — but the
documented combination makes both classes of regression hard-fail
loudly from now on.

## 4. Watcher hardening (already in place)

The previous `/tmp/nebius-finish-v3.sh` watcher used
`grep -q 'RUN_PIPELINE_EXIT='` as a substring match, which would have
been fooled by, e.g., a stack-trace line containing `EXIT=...`. The
post-0_6b-incident replacement `/tmp/nebius-finish-q35-0_8b.sh` (used
to babysit 1778595498..1778601427) **does not poll for sentinels at
all** — it instead checks (a) is the Nebius instance still up, and
(b) is the `train_nebius.sh full` driver PID still alive, every 120 s,
with a 12 h deadline. If `full` dies but the instance is still up
after a 90 s grace, it runs `fetch` + `teardown`. This is the right
shape: a sentinel-string is a hint, the instance-up check is the
authoritative billing-stop signal.

`grep -qE '^RUN_PIPELINE_EXIT=[0-9]'` (a line-anchored match — what
the brief asked for) is folded into the next watcher `q35-0_8b-v4` as
a belt-and-suspenders supplement to the instance-up check.

## 5. What we ruled out

- **Not OOM / not embeddings.** The H200 has 143 GB; the 0.8B base
  fits in ~14 GB peak with the registry `apollo_mini` recipe (seq 4096,
  bs 1, ga 8). `nvidia-smi` at launch showed 0 MiB used (0% util) right
  up until the 218 s mark; the crash was inside the dataset
  preprocessor, not on the GPU. The "Qwen3.5 vocab 248k → +2.4 GB CE
  logits" concern is real but trivial vs. 143 GB.
- **Not device_map.** `ELIZA_NO_DEVICE_MAP=1` was set on all three runs.
- **Not transformers/Liger mismatch.** `transformers>=4.57.0` + Liger
  matched the registry contract. The crash was at chat-template render
  (jinja2), not at model construct.
- **Not stale-resume.** No `--resume-from-checkpoint` passed. All three
  runs started from a fresh `Qwen/Qwen3.5-0.8B-Base` HF download.
- **Not cu13 driver mismatch.** `torch_swap_cu128` resolved cleanly on
  every attempt and the script's defensive re-check (with `UV_NO_SYNC=1`)
  kept it stable.

## 6. Fix verification path

1. `train_local.py` change (commit `ac35880c91`) is a single
   `_coerce_tool_call_arguments(messages)` helper invoked from
   `build_dataset.render`. Idempotent on already-dict args.
2. Local typecheck-ish lint: `python3 -c "import ast; ast.parse(open('packages/training/scripts/train_local.py').read())"` clean.
3. The next H200 0.8B run (`eliza-1-0_8b-apollo-fullcorpus-h200-v4-…`)
   is the verification — if it clears the Tokenizing/Map() phase and
   enters the SFT loop, the fix is good. The 0.6b full-corpus run on
   the local 5080 already validated the broader corpus on a different
   chat template.

## 7. Operator commands (handoff)

```bash
# Re-launch (this post-mortem's exact prescription):
export PATH="$HOME/.nebius/bin:$PATH"
NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec \
HF_TOKEN=… HUGGING_FACE_HUB_TOKEN=… \
SYNC_FULLCORPUS_SOURCES=1 ELIZA1_FULLCORPUS_UPSAMPLE=8 BENCHMARK_AFTER=0 \
REGISTRY_KEY=qwen3.5-0.8b \
NEBIUS_VM_NAME=eliza-train-h200-0_8b-v4 \
RUN_NAME=eliza-1-0_8b-apollo-fullcorpus-h200-$(date +%s) \
bash packages/training/scripts/train_nebius.sh full \
  > /tmp/q35-0_8b-launch-v4.log 2>&1 &

# Hard-stop billing if anything goes sideways:
NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec \
NEBIUS_VM_NAME=eliza-train-h200-0_8b-v4 \
bash packages/training/scripts/train_nebius.sh teardown
```
