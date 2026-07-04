# Issue #12501 - Cloud/local/hybrid parity matrix

## Agent-completed work

- Added a required `parity_matrix` manifest section to
  `packages/benchmarks/meeting-transcription-proof`.
- Added all nine #12501 lanes:
  - `local_asr_local_llm_local_tts`
  - `local_asr_cloud_llm_local_tts`
  - `cloud_asr_cloud_llm_cloud_tts`
  - `cloud_asr_local_llm_local_tts`
  - `native_talkmode_stt_tts`
  - `browser_web_speech_fallback`
  - `offline_mode`
  - `degraded_network_mode`
  - `mobile_bridge_local_inference`
- Validates same scenario ids and artifact schema for non-skipped lanes.
- Requires WER, CER, DER, JER, cpWER, WDER, TTFA, final transcript latency,
  first note latency, CPU, memory, battery delta, thermal state, cloud cost,
  network bytes, failure/retry/dropout rates, and privacy mode per non-skipped
  lane.
- Requires per-lane baseline comparisons and rejects a passing lane with a
  regression.
- Requires explicit `skip_reason` for skipped lanes and keeps skipped lanes out
  of pass counts.
- Makes real reports publishable only when all nine lanes pass with no skips,
  no failures, no baseline regressions, and desktop/mobile/cloud evidence
  platform coverage.
- Updated the registry scorer so orchestrated benchmark results enforce the same
  parity matrix publishability gate.

## Commands run

```bash
python -m json.tool \
  packages/benchmarks/meeting-transcription-proof/fixtures/mock-meeting-manifest.json \
  >/tmp/mtp-fixture-json-check.json
```

Result: passed.

```bash
PYTHONPATH=packages/benchmarks/meeting-transcription-proof \
  python -m py_compile \
  packages/benchmarks/meeting-transcription-proof/elizaos_meeting_transcription_proof/cli.py
```

Result: passed.

```bash
PYTHONPATH=packages/benchmarks/meeting-transcription-proof \
  pytest packages/benchmarks/meeting-transcription-proof/tests -q
```

Result: `37 passed`.

```bash
pytest packages/benchmarks/tests/test_registry_scores.py -q
```

Result: `12 passed`.

```bash
PYTHONPATH=packages \
  python -m benchmarks.orchestrator run \
  --benchmarks meeting_transcription_proof \
  --provider eliza \
  --model eliza \
  --extra '{"lane":"mocked_plumbing"}' \
  --force
```

Result: succeeded with `score=1.0`.

```bash
bun install
```

Result: passed after syncing artifacts to `2026-06-18.1`.

```bash
bun run verify
```

Result: failed outside this PR at `@elizaos/electrobun#lint`.

Failure:

```text
packages/app-core/platforms/electrobun/src/voice/voice-service.test.ts
Formatter would reflow the ELIZA_VOICE_LIVE_RUNTIME env object and two
voiceTurnSignal casts.
```

Manual inspection result: the failing file is unrelated to the benchmark
parity matrix changes in this PR. The command was rerun after the final rebase
onto `origin/develop` and failed at the same electrobun formatter gate. Because
several lint tasks run with `--write`, verify also produced unrelated
auto-format churn before failing; that generated churn was restored and is not
part of this PR.

## Smoke report inspected

Generated report:
`/tmp/mtp-12501/meeting-transcription-proof-report.json`

Observed summary:

```json
{
  "lane": "mocked_plumbing",
  "publishable": false,
  "score": 1.0,
  "parity_summary": {
    "required_lane_count": 9,
    "pass_count": 1,
    "fail_count": 0,
    "skip_count": 8,
    "non_skipped_lane_count": 1,
    "scenario_count": 20,
    "baseline_regression_count": 0,
    "publishable": false,
    "evidence_platforms": ["cloud", "desktop", "mobile"]
  }
}
```

Manual inspection result: the mocked lane remains non-publishable and skipped
parity lanes are explicit, named, and not counted as passes.

## Human-blocked evidence

N/A for this PR because no live meeting providers, native device, mobile
simulator/device capture, browser Web Speech session, network shaping, cloud
provider billing logs, or local fused inference runtime were available to this
agent. The follow-up human issue must provide the real desktop/mobile/cloud
audio-video captures, resource logs, metrics JSON, baseline comparison artifacts,
and provider cost/network records required to produce a publishable
`real_product` parity matrix.
