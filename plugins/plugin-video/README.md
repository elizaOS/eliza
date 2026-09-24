# @elizaos/plugin-video

Video download, processing, and transcription service for Eliza agents.

Video processing requires the download/transcoding tools used by the service and a
configured transcription model. Retrieve it as ServiceType.VIDEO. The content_cache
directory is relative to the process working directory; callers own cleanup.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-video build  # build
bun run --cwd plugins/plugin-video test   # tests
```
