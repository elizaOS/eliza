# @elizaos/plugin-meetings

Meeting transcription for elizaOS agents — browser bots that join Google Meet /
Microsoft Teams / Zoom as guests, capture per-speaker audio, transcribe through the
runtime model layer (`ModelType.TRANSCRIPTION`), and land live, diarized transcripts in
the Transcripts view and knowledge store.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-meetings build  # build
bun run --cwd plugins/plugin-meetings test   # tests
```
