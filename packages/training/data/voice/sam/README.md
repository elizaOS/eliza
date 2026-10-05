# Sam voice corpus

Research voice data derived from the `sam/` subset of
[`lalalune/ai_voices`](https://github.com/lalalune/ai_voices). `source.json` pins
provenance; `manifest.jsonl` records clips and transcript exclusions.

The upstream repository has no LICENSE file and describes research use only;
the audio derives from *Her* (2013, Warner Bros). Do not redistribute raw audio.
Keep derivatives research-only and preserve upstream attribution and the source
commit. These notes do not grant redistribution rights.

Regenerate with the training environment installed, from the repository root
(requires ffmpeg; use the script's help for transcription dependencies):

```bash
python3 packages/training/scripts/voice/build_sam_manifest.py --sparse-clone /tmp/ai_voices --dst packages/training/data/voice/sam
```

Test the manifest builder from `packages/training`:

```bash
uv run --extra train python -m pytest scripts/voice/test_build_sam_manifest.py
```

Audio stays ignored. Respect `excluded` records rather than training on known
transcription failures.
