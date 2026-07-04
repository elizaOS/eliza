# Issue 13359 - QMSum / MeetingBank Adapter Contract

## Scope

Added a metadata-only adapter contract for QMSum and MeetingBank under
`packages/benchmarks/meeting-transcription-proof`. The contract records source
URLs, license/access notes, selected splits, row-selection policy, required
hashes, `elizaos.meeting_artifact.v1` output schema, scenario-runner metadata,
score JSON metrics, and eval-only separation without committing raw external
dataset rows.

## Source Review

- QMSum GitHub checked on 2026-07-04.
  - Repository license: MIT.
  - Public README describes 1,808 query-summary pairs over 232 meetings across
    Academic, Product, and Committee domains.
  - Data is available under `data/ALL` and domain folders with train/val/test
    splits.
- MeetingBank project page checked on 2026-07-04.
  - Describes 1,366 city-council meetings, more than 3,579 hours of video,
    transcripts, minutes, agenda, metadata, and 6,892 segment-level
    summarization instances.
  - Usage points to Hugging Face, Zenodo, and archive.org resources.

## Validation

- `pytest packages/benchmarks/meeting-transcription-proof/tests/test_dataset_adapters.py -q`
- `python -m compileall packages/benchmarks/meeting-transcription-proof/elizaos_meeting_transcription_proof/dataset_adapters.py`
- `git diff --check`

## Evidence Boundary

This PR does not claim publishable benchmark scores. #13359 still requires a
real provider/model run over downloaded rows, source revision and content hashes,
`elizaos.meeting_artifact.v1` outputs, score JSON, and manually reviewed
success/failure artifacts.
