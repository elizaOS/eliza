# Meeting datasets: zoomGroupStats + VCAPurdue (adapters + baselines)

Issue: #13359 (parent #13352). Extends the #13378 meeting dataset adapter contract.

## What was added

Two video-conferencing datasets, each honestly typed to its real modality.

### 1. zoomGroupStats — transcription + diarization (fits the meeting-artifact contract)

- Source: https://github.com/andrewpknight/zoomGroupStats (https://zoomgroupstats.org), **MIT**.
- New adapter `zoomgroupstats_p0_smoke` appended to
  `elizaos_meeting_transcription_proof/dataset_adapters.py`
  (`output_schema = elizaos.meeting_artifact.v1`, `raw_rows_committed = False`).
- New **executable** importer `zoom_vtt.py`: parses a Zoom `transcript.vtt` (both the
  classic `Speaker: text` inline form and the newer `<v Speaker>text</v>` voice-tag form)
  into canonical `eliza.meeting_artifact.v1` transcript spans (ms offsets) + a diarized
  speaker roster with stable `speaker-<slug>` foreign keys. Unlabeled cues map to
  `UNIDENTIFIED` (mirrors zoomGroupStats' `userName` NA handling).
- Because zoomGroupStats' native signal is transcript + **diarization**, the adapter
  declares the 5 contract-required (reference-free / judge-scored) metrics **plus** its
  primary gate: `diarization_error_rate`, `transcript_word_error_rate`,
  `speaker_attribution_accuracy`.

### 2. VCAPurdue — network / QoE (different modality, separate contract)

- Source: https://www.cs.purdue.edu/homes/fahmy/datasets/VCAPurdue/ (Cherian, Prasad,
  Fahmy, PAM 2026). ~2.6 GB, direct download, **no stated license** (academic-use assumed;
  cite the paper).
- **Honest finding:** VCAPurdue has NO audio/speech/speaker labels/transcripts — packet
  traces + BESS buffer logs + frame-derived QoE (SSIM/PSNR/VIF) for Webex/Meet/Teams/Zoom.
  It **cannot** benchmark ASR or diarization. Forcing it into the meeting-artifact contract
  would be dishonest, so it gets a sibling contract `elizaos.vc_network_qoe.v1` in
  `network_qoe_adapters.py` (adapter `vca_purdue_qoe`, `transcription_usable = False`) for
  the network-side VC benchmark axis (congestion control, bandwidth adaptation, QoE).

## Baselines (compare.py-style: a reference system, not a fixed number)

- **zoomGroupStats diarization** → DER vs the `pyannote.audio speaker-diarization-3.1`
  reference used in `packages/benchmarks/voice-speaker-validation` (test DER ≤ 0.45,
  production target 0.25).
- **zoomGroupStats transcript** → WER vs a Whisper reference (large-v3 / Groq Whisper
  cascade), matching `voicebench`.
- **VCAPurdue** → delta of an elizaOS RTP/capture path vs the dataset's measured per-app
  behavior under a matched network scenario.

## Data discipline

- **No raw dataset rows committed.** Both adapters are `downloaded-eval`; the only fixture
  is a **synthetic, self-authored** `fixtures/zoom_transcript_sample.vtt` (not real
  participant data) that drives the deterministic parser test.
- Both adapters are `eval_only = True`, `training_allowed = False`.

## Verification

```
uv run --with pytest python -m pytest packages/benchmarks/meeting-transcription-proof/tests/ -q
# 46 passed
```

Covers: contract validity for all three transcript adapters (QMSum/MeetingBank/zoomGroupStats),
the zoomGroupStats DER/WER baseline, the VTT parser (ordered turns, ms timing, voice-tag form,
UNIDENTIFIED fallback, canonical segment/foreign-key emission, clamped negative-duration), and
the VCAPurdue QoE contract (network-QoE modality, data-free, eval-only, reference baseline).

## Follow-ups flagged

- Schema-id mismatch: the TS canonical is `eliza.meeting_artifact.v1`
  (`packages/shared/src/meeting-artifacts.ts`) but the Python contract uses
  `elizaos.meeting_artifact.v1`. Reconcile in a follow-up so producers/validators agree.
- Publishable runs still require a real provider + judge model (per the contract); this PR
  is the data-free adapter + importer layer, not the live scored run.
