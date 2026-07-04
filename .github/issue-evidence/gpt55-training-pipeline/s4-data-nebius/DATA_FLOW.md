# End-to-end data flow: harvest trajectory → training corpus → Nebius fine-tune

LEG S4. Every link is either **PROVEN** (run live this session) or
**OPERATOR-GATED** with the exact requirement. Stage 1 does NOT run the full
corpus — it proves the two riskiest links (extractor, Nebius reach) on a small slice.

```
[1] harvest trajectory        [2] extractor            [3] dataset jsonl        [4] HF push           [5] Nebius fine-tune
    scenario native.jsonl  ─▶  extract_trajectory_  ─▶  data/final/          ─▶  hf upload         ─▶  train_nebius.sh full
    OR tj-*.json recorder      to_native.py             {train,val,test}.jsonl   elizaos/eliza-1-*     (APOLLO SFT on H200)
```

## [1] Harvest trajectory (two real shapes — both handled)

- **Scenario runner** (`packages/scripts/run-live-scenarios.mjs`) already emits
  `eliza_native_v1` directly via `EXPORT_NATIVE_PATH=…/native.jsonl`. Each row
  carries a `scenarioStatus` (passed/failed) — the correctness gate. For Stage 2's
  gpt-5.5 harvest, "keep correct trajectories" == keep `scenarioStatus == passed`.
  Real sample: `/Users/shawwalters/eliza-workspace/milady/eliza/reports/scenarios/pr-deterministic-orchestrator/native.jsonl` (3 rows, all `passed`).
- **Native trajectory recorder** — on-disk `tj-<id>.json` under
  `${STATE_DIR}/trajectories/<agentId>/`. Richer per-stage shape: each stage's
  `model.{messages,response,toolCalls,finishReason}`. NOT yet `eliza_native_v1`.
  Real sample: `~/.local/state/milady/trajectories/b850bc30-…/tj-3c1872eff37bd2.json`.

## [2] Extractor  — PROVEN

`packages/training/scripts/extract_trajectory_to_native.py` (added this leg).
Dependency-free (stdlib + `lib.native_record`). Reads either shape, emits one
validated `eliza_native_v1` row per model boundary through the same acceptance
gate the corpus builder uses (`lib.native_record.validate_native_record`).

- Recorder rows are emitted **verbatim** — the model's real output
  (`stage.model.response`) becomes `response.text`; recorder `toolCalls`
  `{id,name,args}` are mirrored to AI-SDK `{toolCallId,toolName,input}`. It never
  fabricates a `thought` envelope, so the training target == what the model emitted.
- `--require-pass` drops failed/skipped scenario rows (`scenarioStatus` /
  `metadata.scenario_status` ∈ {failed,error,skipped,timeout,…}) — enforces "train
  only correct trajectories" (#8795).

**Proofs (this session):**
- Recorder → native: `tj-3c1872eff37bd2.json` → `proven-recorder.native.jsonl`
  (1 row, `validate_native_record` = True; `request.system`+1 user msg;
  `response.text` verbatim + `finishReason=tool_calls` + `toolCalls[0]`=
  `{toolCallId,toolName,input}`).
- native.jsonl passthrough + `--require-pass` → `proven-scenario-passonly.native.jsonl`
  (3/3 kept, all `passed`).
- Gate is non-vacuous: synthetic 1-passed/1-failed file → `--require-pass` emits 1,
  `dropped_failed_scenario=1`; without the flag emits 2.

Reuse invocation (Stage 4 will run this over the whole gpt-5.5 harvest):
```bash
cd /Users/shawwalters/eliza-workspace/milady/eliza/packages/training
python3 scripts/extract_trajectory_to_native.py \
  --input <native.jsonl|tj-*.json> --require-pass --output data/final/train.jsonl
```

The in-runtime TS equivalent (used when a live AgentRuntime is up) is
`plugins/plugin-training` `buildElizaNativeTrajectoryRows` /
`trajectory-task-datasets.ts`; this script is its offline, boot-free twin for the
harvest→JSONL link. The canonical in-repo split builder that produces the
train/val/test files is `scripts/prepare_eliza1_trajectory_dataset.py`.

## [3] Dataset jsonl (the `eliza_native_v1` schema)

One row = one Vercel AI SDK `generateText` boundary. Canonical builder:
`packages/training/scripts/lib/native_record.py` (`FORMAT="eliza_native_v1"`,
`boundary="vercel_ai_sdk.generateText"`, `schemaVersion=1`).
```json
{"format":"eliza_native_v1","schemaVersion":1,"boundary":"vercel_ai_sdk.generateText",
 "request":{"system":"…","messages":[{"role":"user","content":"…"}],"tools":[…],"settings":{"temperature":0.0,"topP":1.0}},
 "response":{"text":"<verbatim model output>","finishReason":"tool_calls","toolCalls":[{"toolCallId":"…","toolName":"…","input":{…}}]},
 "trajectoryId":"…","agentId":"…","metadata":{…}}
```
Acceptance gate (`validate_native_record`): format match, boundary ∈
{generateText, streamText}, `request` has ≥1 user turn (messages) OR a non-empty
`prompt`, `response` has non-empty `text` OR a non-empty `toolCalls`. The calibration
loader (`scripts/quantization/_common.py::load_calibration_prompts`) reads the same
shape (last user turn in `request.messages`) with a legacy `currentMessage.content` fallback.

## [4] HF push  — write access PROVEN (push not executed, to avoid polluting prod)

- `HfApi().whoami()` = `shawmakesmagic`, orgs `[elizaos, BabylonMarket]`,
  **token role = write**. Both target datasets exist and are listable:
  - `elizaos/eliza-1-training-data` (16 files: `converted/{xlam,hermes,glaive,openclaw}/…`,
    `converted/merged/{train,val,test}.jsonl`) — the converted function-calling sets.
  - `elizaos/eliza-1-training` (large: `sft/…`, `synthesized/…`, root `train/val/test.jsonl`,
    `validation/…`) — the full corpus repo the training default `--hf-repo` points at.
  Full listing: `HF_TREE.txt`.
- Uploader used by the runtime cron: `plugins/plugin-training/src/core/trajectory-hf-upload.ts`
  → shells `hf upload <repo> <file> <path-in-repo> --repo-type dataset` (token from
  `HF_TOKEN`/`HUGGINGFACE_HUB_TOKEN`). `hf` CLI present at `/opt/miniconda3/bin/hf`.
- **Operator/CI step (not run here — writing to a public prod dataset is a real
  mutation):**
  ```bash
  export HF_TOKEN="$(cat ~/.cache/huggingface/token)"
  hf upload elizaos/eliza-1-training-data data/final/train.jsonl \
     converted/harvest/gpt55-train.jsonl --repo-type dataset
  ```

## [5] Nebius fine-tune launch  — OPERATOR-GATED (one browser re-auth)

Full assessment + operator steps: `NEBIUS_READINESS.md`. Summary:
CLI v0.12.195, config (project `project-e00kfz6cpr00q21z892vec`), `uv`, `apollo-torch`,
HF token — all present. The only blocker is an expired federation token →
`nebius auth login` (interactive browser, once). Then:
```bash
export NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec
export HUGGING_FACE_HUB_TOKEN="$(cat ~/.cache/huggingface/token)"
cd /Users/shawwalters/eliza-workspace/milady/eliza/packages/training
REGISTRY_KEY=gemma4-e2b bash scripts/train_nebius.sh full   # provision→sync→APOLLO SFT→fetch→teardown
```
The old box `89.169.115.174` is torn down and irrelevant (each run provisions a
fresh ephemeral H200). Vast.ai is the canonical alternative (`train_vast.sh`,
key present at `~/.config/vastai/vast_api_key`).
```
```
```

## Link status table

| Link | Status | Proof / requirement |
|---|---|---|
| 1 harvest → 2 | PROVEN | real native.jsonl + real tj-*.json both consumed |
| 2 extractor → 3 | PROVEN | 2 real conversions + non-vacuous gate test |
| 3 jsonl schema | PROVEN | `validate_native_record` = True on emitted rows |
| 4 HF push | AUTH PROVEN | token role=write, repos listable; push = 1 operator cmd |
| 5 Nebius launch | OPERATOR-GATED | one `nebius auth login`; then non-interactive |
