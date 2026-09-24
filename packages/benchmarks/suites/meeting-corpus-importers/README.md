# Meeting Corpus Importers

License-gated importer contracts for #12491. The package does not download or
bundle real corpora. It discovers local cache folders, reports missing corpora
honestly, and parses small synthetic fixture annotations that exercise the same
manifest shape expected from real AMI, CHiME/DiPCo, LibriCSS, VoxConverse,
DIHARD, MUSAN, WHAMR, and LibriMix imports.

## Run

```bash
python -m pytest tests -q
```

## Scope

- P0 corpus registry with license/citation metadata.
- Deterministic local-cache manifest generation.
- Fixture parser that emits transcript, speaker-turn, source-stream, RTTM, and
  annotation-coverage data.
- Honest skip/missing status for unavailable licensed corpora.

Real corpus downloads, terms review, and live model runs are human-gated and
tracked outside this code-only package.
