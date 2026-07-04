# Issue 12486 Meeting Transcription Proof Smoke Evidence

## What Ran

Mocked plumbing lane for the new `meeting_transcription_proof` benchmark:

```bash
PYTHONPATH=packages/benchmarks/meeting-transcription-proof \
  python -m elizaos_meeting_transcription_proof \
  --lane mocked_plumbing \
  --output .github/issue-evidence/12486-meeting-transcription-proof-smoke

PYTHONPATH=packages \
  python -m benchmarks.orchestrator run \
  --benchmarks meeting_transcription_proof \
  --provider mock \
  --model mock \
  --extra '{"lane":"mocked_plumbing"}' \
  --force
```

Output:

- `meeting-transcription-proof-report.json`

## Manual Review

Opened and reviewed `meeting-transcription-proof-report.json`.

Confirmed:

- `lane` is `mocked_plumbing`;
- `publishable` is `false`;
- `provider_mode` is `mock`;
- required surfaces include Zoom, Google Meet, on-device, cloud agent, and
  hybrid local/cloud;
- required capture modes include bot and bot-free;
- stressors include music, noise, babble, overlap, and far-field;
- scenarios include Zoom, Google Meet, on-device, cloud, hybrid, shared-room,
  multi-person, noisy/music/babble/overlap/far-field, speaker correction,
  voice-profile deletion, and transcript sharing/export/delete coverage;
- every scenario references required evidence types, and the scenario set
  references every required evidence type at least once;
- metric shape includes WER, CER, speaker-attributed WER, DER/JER,
  overlap-aware WER, active-speaker accuracy, voice-profile false accept/reject
  rates, EOT/barge-in/P95 latency, notes factuality, and action-item extraction;
- dataset sources cover music, noise, babble, overlapped speech,
  far-field/reverberant rooms, multiple people on one stream, shared room
  microphones, and audiovisual meeting conditions;
- dataset sources include version and checksum fields;
- capture paths include Zoom/Google Meet bot and bot-free, on-device, cloud
  agent, and hybrid routes with participant metadata, consent disclosure, media
  streams, and evidence types;
- speaker operations include enrollment, known speaker recognition, unknown
  speaker creation, name correction, merge/split, deletion, post-deletion
  non-recognition, multi-speaker single-stream attribution, and shared-room
  uncertainty with privacy controls and confidence policies;
- no evidence files are claimed for the mocked lane.

## Verification Commands

```bash
PYTHONPATH=packages/benchmarks/meeting-transcription-proof \
  pytest packages/benchmarks/meeting-transcription-proof/tests -q

PYTHONPATH=packages \
  pytest packages/benchmarks/tests/test_registry_scores.py \
    packages/benchmarks/tests/test_ci_coverage.py -q

PYTHONPATH=packages \
  python -m benchmarks.orchestrator list-benchmarks | rg meeting_transcription_proof

bun run --cwd packages/docs test

git diff --check
```

## Evidence Rows

- Real LLM trajectory: N/A - this change adds a benchmark registry and docs
  contract; no agent prompt/action/model behavior changed.
- Backend logs: N/A - no server path changed.
- Frontend logs/screenshots/video: N/A - no UI path changed.
- Audio/video/domain artifacts: N/A for this smoke lane. The real lane requires
  those artifacts and fails without them.
