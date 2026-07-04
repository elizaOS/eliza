# Meeting Transcription Proof Benchmark

Canonical proof registry for issue #12486. It separates cheap plumbing checks
from real product proof for Zoom, Google Meet, bot-free/on-device capture, cloud
agents, and hybrid local/cloud inference.

## Run

```bash
# No-key fixture lane. Proves schema/capture/evidence plumbing only.
python -m elizaos_meeting_transcription_proof --lane mocked_plumbing --output /tmp/mtp

# Real product lane. Requires a manifest whose evidence files exist.
python -m elizaos_meeting_transcription_proof \
  --lane real_product \
  --manifest /path/to/real-meeting-manifest.json \
  --output /tmp/mtp-real
```

Through the suite orchestrator:

```bash
python -m benchmarks.orchestrator run \
  --benchmarks meeting_transcription_proof \
  --provider eliza \
  --model eliza \
  --extra '{"lane":"mocked_plumbing"}'
```

## QMSum / MeetingBank Adapter Contract

`elizaos_meeting_transcription_proof.dataset_adapters` defines the P0 adapter
contract for QMSum and MeetingBank without committing raw external data. The
contract records source URLs, license/access notes, selected splits, row
selection policy, required content hashes, `elizaos.meeting_artifact.v1` output
schema, scenario-runner metadata, score JSON metrics, and eval-only separation.

These contracts are not publishable evidence by themselves. A publishable run
must download the selected rows at runtime, record source revisions and hashes,
produce meeting artifacts and score JSON, and attach real provider/model outputs
with manually reviewed representative successes and failures.

### zoomGroupStats (transcription + diarization)

`dataset_adapters.py` also carries `zoomgroupstats_p0_smoke`
([zoomGroupStats](https://zoomgroupstats.org), MIT). Unlike QMSum/MeetingBank
(query-summary corpora), its native signal is transcript accuracy + **diarization**,
so it declares the 5 required (reference-free, judge-scored) metrics plus
`diarization_error_rate` / `transcript_word_error_rate` /
`speaker_attribution_accuracy`. `zoom_vtt.py` is the executable importer: it parses a
Zoom `transcript.vtt` (inline `Speaker: text` and `<v Speaker>text</v>` forms) into
canonical `eliza.meeting_artifact.v1` transcript spans + a diarized speaker roster with
stable foreign keys. **Baseline:** DER vs the `pyannote` reference used in
`voice-speaker-validation`; WER vs a Whisper reference (as in `voicebench`).

```python
from elizaos_meeting_transcription_proof import parse_zoom_vtt
segments = parse_zoom_vtt(open("transcript.vtt").read()).to_meeting_artifact_segments()
# -> {"transcriptSpans": [...], "diarizedSpeakers": [...]}
```

### VCAPurdue (network / QoE — a different modality)

`network_qoe_adapters.py` carries `vca_purdue_qoe`
([VCAPurdue](https://www.cs.purdue.edu/homes/fahmy/datasets/VCAPurdue/)). This dataset
is **network measurement** (packet traces + BESS buffer logs + SSIM/PSNR/VIF QoE for
Webex/Meet/Teams/Zoom) with **no audio, speech, speaker labels, or transcripts** — it
**cannot** benchmark ASR or diarization. Rather than misfit it into the meeting-artifact
contract, it uses a sibling `elizaos.vc_network_qoe.v1` contract for the network-side VC
benchmark axis (congestion control, bandwidth adaptation, objective video QoE), with the
dataset's own measured per-app behavior as the reference baseline. For
transcript+diarization use zoomGroupStats (above) or AMI/ICSI/VoxConverse/DIHARD.

No raw dataset rows are committed for either adapter (`downloaded-eval`); the only
checked-in sample is a synthetic, self-authored `fixtures/zoom_transcript_sample.vtt`
that drives the deterministic parser test.

## Report Contract

The CLI writes `meeting-transcription-proof-report.json`. The scorer accepts two
lanes:

- `mocked_plumbing` verifies schema, adapter, and evidence bundle plumbing over
  bundled fixture records.
- `real_product` requires real capture modes, real audio/video/log/evidence
  files, real transcript quality metrics, and no mock providers.

The real lane's headline score is the minimum of transcript quality, diarization
quality, speaker identity quality, and consent/retention quality. That makes the
report fail honestly when any one proof dimension is weak.

Real manifests must also include detailed voice metrics: WER, CER,
speaker-attributed WER, DER, JER, overlap-aware WER, active-speaker accuracy,
voice-profile false accept/reject rates, end-of-turn latency, barge-in latency,
P95 end-to-end latency, notes factuality, and action-item extraction.

Real manifests must declare external dataset sources for stress and regression
coverage. The dataset section must cover speech over music, noise, babble,
overlap, far-field/reverberant rooms, multiple people on one stream, shared room
microphones, and audiovisual meetings. Each dataset source must include a
version and checksum so the run is reproducible.

The manifest must also enumerate required scenario coverage. A real report
cannot omit Zoom or Google Meet, bot and bot-free capture, on-device, cloud, and
hybrid routes, multiple people on one stream, shared room microphones, music,
noise, babble, overlapped speech, far-field audio, speaker recognition, speaker
correction, profile deletion, and transcript sharing/export/delete. Each
scenario must reference required evidence types from the manifest evidence
inventory, and every required evidence type must be used by at least one
scenario.

Real manifests must include capture path metadata for Zoom bot, Zoom bot-free,
Google Meet bot, Google Meet bot-free, on-device, cloud agent, and hybrid
local/cloud routes. Each capture path must name participant metadata,
consent/disclosure, media streams, and evidence types.

Real manifests must include speaker operation metadata for voice profile
enrollment, known speaker recognition, unknown speaker creation, name
correction, duplicate merge, incorrect split, deletion, post-deletion
non-recognition, multi-speaker single-stream attribution, and shared-room
uncertainty handling. Each operation must name evidence types, metrics, privacy
controls, and the confidence policy used before applying speaker names.

Real manifests must include speaker-name provenance cases for platform roster
names, calendar attendees, self-introductions, user corrections, voice profile
matches, recurring speaker memory after correction, same-first-name ambiguity,
and borrowed-device guardrails. Each case must name the source, surface,
evidence, signals, confidence, conflict policy, confidence policy, privacy
policy, and expected resolution. Low-confidence inferred names cannot be
reported as confirmed identities; they must request confirmation, withhold the
name, or preserve an unknown speaker label.

Real manifests must include audio-visual case metadata for AVA-ActiveSpeaker,
MISP 2025, EasyCom where license permits, synthetic room-feed smoke, off-screen
speaker handling, visual/acoustic disagreement, and audio/video association.
These rows declare video frame, face-track, audio stream, transcript, speaker,
source metadata, active-speaker, person-count, off-screen, association, and
room-feed coverage. The contract reports face-count accuracy, active-speaker
F1/mAP, audio-video association accuracy, off-screen speaker detection accuracy,
room-feed precision/recall, and visual/acoustic disagreement rate while
forbidding face-only identity binding and sensitive attribute shortcuts.

Real manifests must include `generated_artifact_scores` for meeting
intelligence outputs. Required rows are `summary_factuality`,
`action_item_owner_date`, `decision_extraction`, `open_question_extraction`,
`memory_entity_correctness`, `hallucination_rate`, `omission_rate`, and
`source_grounding`. Each row carries `observed_score`, `threshold`,
`higher_is_better`, `passed`, `judge_mode`, and `proof`; the validator checks
that `passed` matches the threshold direction. Deterministic rows must point to
a score report, live-model rows must include the trajectory JSONL, raw prompt,
model output, and judge output, and manual rows must point to a manual review.

`elizaos_meeting_transcription_proof.artifact_scoring` provides the
deterministic artifact scorer for transcript-grounded generated summaries,
action items, decisions, open questions, memory entities, hallucination rate,
omission rate, and source grounding. Live-model artifact scores are still
expected to attach real trajectories and reviewed outputs in the manifest.

Real manifests must include baseline comparison rows for the current Eliza path,
Otter-style bot transcription, Granola-style bot-free capture, Zoom native
notes/transcripts, Google Meet/Gemini notes, WhisperX + pyannote, and NeMo
Sortformer. Rows must mark each system as `run`, `imported`, or `not_run` with a
reason for skipped systems; at least one open-source baseline must be run or
imported, and the current Eliza production baseline must always be present. Rows
track capture/privacy mode, covered meeting conditions, comparison metrics,
artifact references, manual review status, evidence, and the failure policy.

## Fixture Manifest

`fixtures/mock-meeting-manifest.json` describes the minimum canonical meeting
transcript and artifact shape. It is not publishable proof; it exists so CI can
exercise the registry path without credentials, meetings, cameras, or models.

## Tests

```bash
pytest packages/benchmarks/meeting-transcription-proof/tests -q
```
