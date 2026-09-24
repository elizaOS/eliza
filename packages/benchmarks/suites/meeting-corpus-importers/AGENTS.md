# Meeting Corpus Importers — Agent Guide

Self-contained #12491 importer contract package. Not registered in the benchmark
orchestrator; run directly with pytest.

## Run

```bash
python -m pytest tests -q
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_meeting_corpus_importers/corpora.py` | Corpus registry, cache discovery, fixture parser, RTTM emitter |
| `fixtures/synthetic_p0_fixtures.json` | Legal synthetic annotations for every P0 corpus id |
| `tests/test_corpus_importers.py` | Registry, missing-cache, parser, RTTM, and manifest tests |

## Notes

- This package never downloads or vendors real corpora.
- Missing local cache paths return `status: "missing"` and `canRun: false`;
  missing corpora must never count as a pass.
- Fixture annotations are synthetic and exist only to validate parser behavior
  without licensed audio bytes.
- Real model runs and reviewed media artifacts belong in the human evidence lane.
