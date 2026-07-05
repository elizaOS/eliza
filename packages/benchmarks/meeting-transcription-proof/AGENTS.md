# Meeting Transcription Proof — Agent Guide

Issue #12486 benchmark package for meeting transcription, diarization, speaker
identity, and voice UX proof. Registered in the suite as
`meeting_transcription_proof`.

## Run

```bash
# Mocked plumbing lane, no credentials.
python -m elizaos_meeting_transcription_proof --lane mocked_plumbing --output /tmp/mtp

# Real product lane; manifest must point at existing evidence files.
python -m elizaos_meeting_transcription_proof \
  --lane real_product \
  --manifest /path/to/real-meeting-manifest.json \
  --output /tmp/mtp-real
```

## Test

```bash
pytest packages/benchmarks/meeting-transcription-proof/tests -q
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_meeting_transcription_proof/cli.py` | CLI, manifest validation, report writer |
| `elizaos_meeting_transcription_proof/artifact_scoring.py` | Deterministic generated-artifact scoring |
| `fixtures/mock-meeting-manifest.json` | Hermetic schema/capture/evidence fixture |
| `tests/` | Lane separation and real evidence validation tests |

## Scenario Contract

The manifest must enumerate the scenario coverage that proves the product:
Zoom, Google Meet, bot capture, bot-free capture, on-device capture, cloud
agent capture, hybrid local/cloud, multiple people on one stream, shared room
microphone, speech over music/noise/babble, overlapped speech, far-field room,
known/unknown speaker handling, speaker-name correction, voice-profile deletion,
and transcript sharing/export/delete. Each scenario must reference required
evidence types, and every required evidence type must be used by at least one
scenario.

## Metric Contract

The real lane requires WER, CER, speaker-attributed WER, DER, JER,
overlap-aware WER, active-speaker accuracy, voice-profile false accept/reject
rates, end-of-turn latency, barge-in latency, P95 end-to-end latency, notes
factuality, and action-item extraction.

## Audio-Visual Contract

The manifest must enumerate audio-visual case coverage for AVA-ActiveSpeaker,
MISP 2025, EasyCom where license permits, synthetic room-feed smoke,
off-screen speaker handling, visual/acoustic disagreement, and audio/video
association. Each case declares video frames, face tracks, audio streams,
transcripts, speaker ids, source metadata, active-speaker labels, person-count
labels, off-screen labels, association labels, and room-feed labels as
applicable. Case metrics include face-count accuracy, active-speaker F1/mAP,
audio-video association accuracy, off-screen speaker detection accuracy,
room-feed precision/recall, and visual/acoustic disagreement rate.

Face tracks are localization evidence only. Identity binding from face data is
forbidden without an explicit opt-in identity source such as a voice profile,
user correction, calendar participant, or platform roster. Sensitive-attribute
shortcuts are always forbidden.

The real lane also requires generated meeting intelligence scores:
`summary_factuality`, `action_item_owner_date`, `decision_extraction`,
`open_question_extraction`, `memory_entity_correctness`, `hallucination_rate`,
`omission_rate`, and `source_grounding`. Each manifest row must include
`observed_score`, `threshold`, `higher_is_better`, `passed`, `judge_mode`, and
`proof`; the validator rejects rows whose `passed` flag does not match the
threshold direction. `deterministic` rows require `score_report`, `live_model`
rows require `model_trajectory_jsonl`, `raw_prompt`, `model_output`, and
`judge_output`, and `manual` rows require `manual_review`.

## Dataset Contract

The real lane requires external dataset sources covering speech over music,
noise, babble, overlapped speech, far-field/reverberant rooms, multiple people
on one stream, shared room microphones, and audiovisual meetings. Dataset
entries must include source URL, license label, covered conditions, and evidence
types, plus version and checksum fields for reproducibility.

## Capture Contract

The real lane requires capture path metadata for Zoom bot, Zoom bot-free, Google
Meet bot, Google Meet bot-free, on-device, cloud agent, and hybrid local/cloud
routes. Each path must describe participant metadata, consent/disclosure, media
streams, and evidence types.

## Speaker Operation Contract

The real lane requires speaker operation metadata for voice profile enrollment,
known speaker recognition, unknown speaker creation, speaker-name correction,
duplicate speaker merge, incorrect speaker split, voice-profile deletion,
post-deletion non-recognition, multi-speaker single-stream attribution, and
shared-room uncertainty. Each operation must describe evidence types, metrics,
privacy controls, and the confidence policy for applying or withholding speaker
names.

## Speaker Name Provenance Contract

The real lane requires speaker-name provenance cases for platform roster names,
calendar attendees, self-introductions, user corrections, voice profile matches,
recurring speaker memory after correction, same-first-name ambiguity, and
borrowed-device guardrails. Each case must describe source, surface, evidence,
signals, confidence, conflict policy, confidence policy, privacy policy, and the
expected resolution. Low-confidence inferred names cannot be reported as
confirmed identities; they must request confirmation, withhold the name, or
preserve an unknown speaker label.

## Baseline Comparison Contract

The real lane requires baseline comparison rows for the current Eliza path,
Otter-style bot transcription, Granola-style bot-free capture, Zoom native
notes/transcripts, Google Meet/Gemini notes, WhisperX + pyannote, and NeMo
Sortformer. Rows must mark each system as `run`, `imported`, or `not_run` with a
reason for skipped systems; at least one open-source baseline must be run or
imported, and the current Eliza production baseline must always be present.
Rows track capture/privacy mode, covered meeting conditions, comparison
metrics, artifact references, manual review status, evidence, and the failure
policy.

## Adversarial + QA Contract

The real lane requires adversarial cases and QA review checklist rows.
Adversarial cases cover canonical artifact schema fuzzing, transcript/span
alignment, RTTM/diarization segment parsing, speaker profile lifecycle,
capture-source state machines, ASR media refs, meeting-note grounding, and
importer response shapes. Required scenario classes include prompt injection,
negated action items, side conversations, duplicate names, borrowed laptops,
permission revocation, audio deletion, false VAD, overlapping similar voices,
and malformed artifact shapes. QA checklist rows must produce machine-readable
verdicts for permission denied, capture stopped, speaker correction, delete
audio, and share/privacy state.

## Parity Matrix Contract

The real lane requires a `parity_matrix` for the cloud/local/hybrid lanes from
#12501: local ASR+LLM+TTS, local ASR+cloud LLM+local TTS, cloud ASR+LLM+TTS,
cloud ASR+local LLM+local TTS, native TalkMode STT/TTS, browser Web Speech
fallback, offline mode, degraded network mode, and mobile bridge/local
inference. Every non-skipped lane must use the same scenario ids and artifact
schema, cover the full required scenario corpus, include WER, CER, DER, JER,
cpWER, WDER, TTFA, final transcript latency, first note latency, CPU, memory,
battery, thermal state, cloud cost, network bytes, failure/retry/dropout rates,
and privacy mode, plus a baseline comparison. A passing lane cannot carry a
baseline regression. Skipped lanes must set `status: "skip"` and a non-empty
`skip_reason`; skips are never counted as passes. Real reports are publishable
only when all nine parity lanes pass, no lane is skipped or failed, no baseline
regression is present, and the evidence platforms cover desktop, mobile, and
cloud captures.

## Evidence

Mocked reports prove plumbing only. Real reports must reference reviewed audio,
video, logs, screenshots, trajectories, transcript artifacts, speaker profile
artifacts, consent records, and retention/deletion artifacts, attached inline in the PR.
