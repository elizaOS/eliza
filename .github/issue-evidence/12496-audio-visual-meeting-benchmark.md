# #12496 Audio-Visual Meeting Benchmark Evidence

Branch: `fix/12496-av-meeting-benchmark`
Code PR: #13162
Human evidence follow-up: #13163

## What Was Proven

- Added an `audio_visual_cases` manifest/report section to
  `meeting_transcription_proof`.
- Required AV case ids cover:
  - `ava_active_speaker`;
  - `misp_2025_meeting`;
  - `easycom_license_permitting`;
  - `synthetic_room_feed_smoke`;
  - `off_screen_speaker`;
  - `visual_acoustic_disagreement`;
  - `audio_video_association`.
- Required AV coverage includes video frames, face tracks, audio streams,
  transcripts, speaker ids, source metadata, active-speaker labels,
  person-count labels, off-screen speaker labels, audio/video association
  labels, and room-feed labels.
- Added AV metrics to the contract: face-count accuracy, active-speaker F1/mAP,
  audio-video association accuracy, off-screen speaker detection accuracy,
  room-feed heuristic precision/recall, and visual/acoustic disagreement rate.
- Added identity-policy guardrails: face tracks cannot silently bind personal
  identity, and sensitive-attribute shortcuts are forbidden.
- Updated the mock fixture and docs.
- Registry scoring now requires `audio_visual_cases` and the AV metrics for
  real meeting-transcription reports.

## Verification

```bash
PYTHONPATH=packages/benchmarks/meeting-transcription-proof python -m pytest packages/benchmarks/meeting-transcription-proof/tests -q
```

Result: `28 passed`.

```bash
python -m pytest packages/benchmarks/tests/test_registry_scores.py -q
```

Result: `9 passed`.

```bash
python -m py_compile packages/benchmarks/meeting-transcription-proof/elizaos_meeting_transcription_proof/cli.py packages/benchmarks/meeting-transcription-proof/tests/test_cli.py
```

Result: passed.

```bash
python -m elizaos_meeting_transcription_proof --lane mocked_plumbing --output /tmp/mtp-smoke-audio-visual-cases-12496
```

Result: emitted
`/tmp/mtp-smoke-audio-visual-cases-12496/meeting-transcription-proof-report.json`.

Manual report inspection:

```text
audio_visual_case_count: 7
ids: audio_video_association, ava_active_speaker, easycom_license_permitting, misp_2025_meeting, off_screen_speaker, synthetic_room_feed_smoke, visual_acoustic_disagreement
av_metrics: face_count_accuracy=1.0, active_speaker_f1=1.0, active_speaker_map=1.0, audio_video_association_accuracy=1.0, off_screen_speaker_detection_accuracy=1.0, room_feed_heuristic_precision=1.0, room_feed_heuristic_recall=1.0, visual_acoustic_disagreement_rate=0.0
identity_policies: forbidden_without_explicit_opt_in
```

## Evidence Rows

- Parsed audio-visual fixture: mocked fixture and generated report inspected.
- Active speaker metrics: present in generated report.
- Video screenshot/contact sheet: N/A for code-only mocked contract; real
  contact sheets require licensed video or live product capture.
- Example room-feed classifier JSON: represented by the synthetic room-feed
  case contract; real classifier output remains evidence-gated.
- Manual review notes: this file records manual inspection of the generated
  mocked report; real video/audio review remains human-gated.
- Real AV dataset/model run: N/A here; requires licensed AVA/MISP/EasyCom data
  or live capture, model artifacts, and manual review.
