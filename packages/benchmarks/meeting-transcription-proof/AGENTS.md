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

## Evidence

Mocked reports prove plumbing only. Real reports must reference reviewed audio,
video, logs, screenshots, trajectories, transcript artifacts, speaker profile
artifacts, consent records, and retention/deletion artifacts under
`.github/issue-evidence/<issue#>-<slug>/`.
