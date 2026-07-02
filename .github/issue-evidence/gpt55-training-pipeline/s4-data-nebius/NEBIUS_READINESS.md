# Stage 5 (Nebius fine-tune) readiness assessment — LEG S4

Captured 2026-07-02 on this machine (M4 Max). All paths absolute.

## Verdict

**Stage 5 is fully wired and 95% ready. The ONE remaining blocker is operator-gated:
a single interactive `nebius` browser OAuth re-login (the cached federation token
has expired).** No code, no missing script, no missing credential file. Once the
operator re-auths, `bash scripts/train_nebius.sh full` provisions a fresh H200,
syncs the corpus, runs the APOLLO SFT pipeline, fetches checkpoints, and tears
the box down.

The old box `ubuntu@89.169.115.174` is dead (ssh timed out) — but it is
**irrelevant**. `train_nebius.sh` provisions an ephemeral VM every run; the IP is
never persisted or reused. Nothing depends on restoring that host.

## What exists on THIS machine (verified)

| Component | Status | Evidence |
|---|---|---|
| Training pipeline (Python) | PRESENT | `/Users/shawwalters/eliza-workspace/milady/eliza/packages/training/` |
| Nebius launcher | PRESENT | `packages/training/scripts/train_nebius.sh` (full lifecycle: smoke/provision/sync/run/fetch/teardown) |
| APOLLO optimizer dep | PRESENT | `packages/training/pyproject.toml:48` → `apollo-torch>=1.0.3`; `tests/test_apollo_default.py` |
| Top-level pipeline | PRESENT | `scripts/run_pipeline.py` (SFT → gate bench → quant → GGUF bundle) |
| `nebius` CLI | INSTALLED v0.12.195 | `/Users/shawwalters/.nebius/bin/nebius` |
| Nebius config | PRESENT | `~/.nebius/config.yaml`: profile `default`, endpoint `api.nebius.cloud`, auth-type `federation`, **parent-id `project-e00kfz6cpr00q21z892vec`**, tenant `tenant-e00fsc1tnxh53s8ztj` |
| Nebius credentials file | PRESENT (stale) | `~/.nebius/credentials.yaml` — federation token expired; CLI prompts for browser re-auth |
| `uv` env manager | PRESENT v0.7.13 | `/Users/shawwalters/.local/bin/uv` |
| HF token (gated Gemma + push) | PRESENT, role=write | `~/.cache/huggingface/token`; whoami=`shawmakesmagic`, orgs=`[elizaos, BabylonMarket]` |
| Vast.ai (canonical cloud alt) | KEY PRESENT | `~/.config/vastai/vast_api_key`; `scripts/train_vast.sh` |

`NEBIUS_PROJECT_ID` (the one required env var, per `train_nebius.sh:86`) == the
config `parent-id` = `project-e00kfz6cpr00q21z892vec`. No separate secret needed.

## The one gate — reproduce it

```
$ export PATH="$HOME/.nebius/bin:$PATH"
$ nebius vpc v1 subnet list --parent-id project-e00kfz6cpr00q21z892vec --format json
Switch to your browser to complete the authentication process...
  https://auth.nebius.com/oauth2/authorize?client_id=nebius-cli&...
```

The CLI opens an OAuth flow instead of returning data → the federation session
lapsed. This is a headless-agent hard stop (needs a human browser), not a code
defect.

## EXACT operator steps to make Stage 5 runnable

1. **Re-auth the Nebius CLI (interactive, ~30 s, once):**
   ```bash
   export PATH="$HOME/.nebius/bin:$PATH"
   nebius auth login            # completes the browser OAuth; refreshes ~/.nebius/credentials.yaml
   # confirm:
   nebius vpc v1 subnet list --parent-id project-e00kfz6cpr00q21z892vec --format json | head
   ```
2. **Export the two required env vars** (HF token can be read from the cache file):
   ```bash
   export NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec
   export HUGGING_FACE_HUB_TOKEN="$(cat ~/.cache/huggingface/token)"   # gated Gemma + push
   ```
3. **(Optional) cheap plumbing smoke** — pennies, validates the live CLI end to end:
   ```bash
   cd /Users/shawwalters/eliza-workspace/milady/eliza/packages/training
   bash scripts/train_nebius.sh smoke     # cpu-e2 up → uname → teardown
   ```
4. **Launch the real fine-tune** (single H200 for the 2b/4b/9b tiers):
   ```bash
   cd /Users/shawwalters/eliza-workspace/milady/eliza/packages/training
   REGISTRY_KEY=gemma4-e2b \
   TRAIN_FILE=data/final/train.jsonl VAL_FILE=data/final/val.jsonl TEST_FILE=data/final/test.jsonl \
   bash scripts/train_nebius.sh full
   # full = provision (gpu-h200x1) → sync training tree + corpus → run_pipeline.py
   #        (APOLLO SFT → gate bench → PolarQuant/QJL/fused-TurboQuant → eliza1 GGUF)
   #        → fetch checkpoints/benchmarks/reports → teardown. EXIT trap guarantees
   #        fetch+teardown even on poll-timeout.
   ```

`REGISTRY_KEY` → tier map (`train_nebius.sh:27-31`): `gemma4-e2b`→eliza-1-2b,
`gemma4-e4b`→eliza-1-4b, `gemma4-12b`→eliza-1-9b (all single H200);
`gemma4-31b`→eliza-1-27b needs `NEBIUS_VM_PRESET=gpu-h200x2` (8×H200, expensive —
prefer Vast).

## What is doable NOW vs gated

- **Doable now (no human):** build the corpus (`data/final/{train,val,test}.jsonl`)
  via the extractor + existing `scripts/prepare_eliza1_trajectory_dataset.py`;
  validate every row (`lib.native_record.validate_native_record`); push the dataset
  to HF (token is live, role=write — proven).
- **Operator-gated (needs a human once):** the `nebius auth login` browser step.
  After that the entire provision→train→fetch→teardown chain is non-interactive.
- **Cost-gated:** an H200 SXM run bills real money; `train_nebius.sh` never
  provisions without the operator invoking it. The 27b tier (8×H200) requires
  explicit confirmation.

## Corpus that Stage 5 trains on

`train_nebius.sh` defaults to `data/final/{train,val,test}.jsonl` (or
`data/final-eliza1-fullcorpus/` with `SYNC_FULLCORPUS_SOURCES=1`). Stage 4's job
is to emit correct-only `eliza_native_v1` rows (via `extract_trajectory_to_native.py`)
into those splits before launch. The remote run passes `--allow-unvalidated-corpus`
by default because the 0_6b mix-in rows are ChatML; a pure native-record corpus can
set `ALLOW_UNVALIDATED_CORPUS=0` for the strict `validate_corpus.py` gate.
