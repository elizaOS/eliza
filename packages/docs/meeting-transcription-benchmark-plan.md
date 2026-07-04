# Meeting Transcription Benchmark Plan

Issue: #12486

## Goal

Build one proof system for Eliza meeting transcription across Zoom, Google Meet,
on-device capture, cloud agents, and hybrid local/cloud inference. The benchmark
registry must run two lanes separately:

- `mocked_plumbing`: no-key fixture lane for schema, adapter, artifact, and
  evidence-bundle plumbing.
- `real_product`: real product lane for reviewed Zoom, Google Meet, device,
  cloud, and hybrid runs with audio, video, logs, screenshots, metrics, model
  trajectories, consent records, retention artifacts, and generated transcripts.

## Canonical Artifacts

Every meeting proof bundle uses one canonical transcript record with these
required fields:

- `meeting_id`
- `source`
- `consent`
- `segments`
- `speakers`
- `artifacts`
- `retention_policy`

The benchmark also requires adapter metadata for Zoom and Google Meet, capture
mode metadata for bot and bot-free paths, and stressor metadata for music,
noise, babble, overlap, and far-field conditions.
The real lane also requires external dataset source metadata for speech over
music, speech over noise, speech over babble, overlapped speech,
far-field/reverberant rooms, multiple people on one stream, shared room
microphones, and audiovisual meeting coverage. Each dataset entry must include
version and checksum fields so a reviewer can reproduce the exact source bundle.

Every manifest must enumerate scenario coverage for clean single-speaker
dictation, Zoom bot, Zoom bot-free, Google Meet bot, Google Meet bot-free,
on-device capture, cloud agent capture, hybrid local/cloud, multiple people on
one stream, shared room microphones, speech over music, speech over noise,
speech over babble, overlapped speech, far-field rooms, known speaker
recognition, unknown speaker creation, speaker-name correction, voice-profile
deletion, and transcript sharing/export/delete.
Each scenario must reference required evidence types, and the full scenario set
must reference every required evidence type at least once so no evidence artifact
can be declared without being tied to product behavior.

Every manifest must also enumerate speaker operations for voice profile
enrollment, known speaker recognition, unknown speaker creation, speaker-name
correction, duplicate speaker merge, incorrect speaker split, voice-profile
deletion, post-deletion non-recognition, multi-speaker single-stream
attribution, and shared-room uncertainty handling. Each operation must declare
evidence, metrics, privacy controls, and the confidence policy for when speaker
names are applied or withheld.

Every manifest must also enumerate baseline comparisons against external
products, open-source baselines, and the current elizaOS production path. The
required comparison rows are Otter-style bot transcription, Granola-style
bot-free capture, Zoom native notes/transcripts, Google Meet/Gemini notes,
WhisperX + pyannote, NeMo Sortformer, and `eliza_current_baseline`. Commercial
systems that cannot be run are `not_run` with a reason, never counted as pass.
At least one open-source row must be run or imported.

## Registry Contract

The integrated benchmark id is `meeting_transcription_proof`.

The registry command accepts:

- `extra.lane="mocked_plumbing"` for the hermetic fixture lane.
- `extra.lane="real_product"` and `extra.manifest="<path>"` for a real evidence
  manifest.

The real lane refuses non-evidence reports. It requires:

- non-mock provider mode;
- Zoom and Google Meet adapters;
- bot and bot-free capture modes;
- capture path metadata for Zoom bot, Zoom bot-free, Google Meet bot, Google
  Meet bot-free, on-device, cloud agent, and hybrid local/cloud paths, including
  participant metadata, consent/disclosure, media streams, and evidence types;
- all required meeting surfaces;
- all required acoustic stressors;
- external dataset source coverage for music, noise, babble, overlap,
  far-field/reverberant rooms, multi-speaker single-stream audio, shared room
  microphones, and audiovisual meetings;
- speaker operation coverage for enrollment, recognition, unknown speaker
  creation, naming correction, merge/split, deletion, post-deletion replay,
  multi-speaker single-stream attribution, and shared-room uncertainty;
- baseline comparison coverage for required external product, open-source, and
  internal baseline rows, with at least one open-source run/import and the
  current Eliza production baseline;
- all required scenario coverage IDs;
- each scenario's evidence references are valid and covered by the manifest's
  evidence inventory;
- numeric transcript, diarization, speaker identity, and consent/retention
  quality metrics in `[0, 1]`;
- detailed WER, CER, speaker-attributed WER, DER, JER, overlap-aware WER,
  active-speaker accuracy, voice-profile false accept/reject rates,
  end-of-turn latency, barge-in latency, P95 end-to-end latency, notes
  factuality, and action-item extraction metrics;
- existing evidence files for audio, video, backend logs, frontend logs,
  screenshots, metrics, model trajectories, transcript artifact, speaker
  profile artifact, consent record, and retention artifact.

## Score

The real product score is the minimum of:

- transcript quality;
- diarization quality;
- speaker identity quality;
- consent and retention quality.

The minimum is intentional. Meeting transcription proof is only as strong as the
weakest safety or quality dimension.

## Evidence Review

For a real lane run to count, the reviewer must be able to inspect the evidence
without reading code:

- audio and video recordings of the meeting capture path;
- capture path metadata showing participant metadata source, consent/disclosure,
  media streams, and evidence for Zoom/Meet bot and bot-free paths;
- transcript and diarization artifacts;
- speaker enrollment, recognition, merge/split, naming, and revocation
  artifacts;
- speaker operation policy metadata showing privacy controls and confidence
  thresholds for applying names, preserving unknown labels, and using room-level
  labels when evidence is ambiguous;
- backend and frontend logs showing the actual product path;
- desktop and mobile screenshots for correction, sharing, consent, and
  retention UX;
- model trajectories for any agent/action/provider/model behavior;
- metrics report with WER, CER, speaker-attributed WER, DER/JER,
  overlap-aware WER, active-speaker accuracy, voice-profile false accept/reject
  rates, latency metrics, notes factuality, action-item extraction, and
  consent/retention pass status.
- dataset manifests/checksums/license notes showing the public or controlled
  corpus inputs behind the acoustic stress cases.
- baseline comparison artifacts for each compared system, including terms/usage
  notes for commercial imports and manual review notes for at least one
  transcript and one notes artifact per compared system.
