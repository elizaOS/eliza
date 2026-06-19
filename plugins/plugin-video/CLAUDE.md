# @elizaos/plugin-video

Video download, processing, and transcription service for Eliza agents.

## Purpose / role

Adds `VideoService` to an Eliza agent's service registry (`ServiceType.VIDEO`). The service handles downloading videos from YouTube, Vimeo, and direct MP4 URLs; converting them to audio; extracting transcripts from subtitles or captions; and falling back to an audio transcription service when no subtitles are available. The plugin has no actions, providers, or routes — all capability is exposed through the service interface. It is opt-in; agents must include `@elizaos/plugin-video` in their plugin list explicitly.

## Plugin surface

| Kind | Name | Description |
|------|------|-------------|
| Service | `VideoService` (`ServiceType.VIDEO`) | Download, transcode, and transcribe video from URLs |

No actions, providers, evaluators, routes, or events are registered.

## Layout

```
src/
  index.ts                  Plugin definition; exports default videoPlugin
  services/
    video.ts                VideoService — IVideoService implementation
    binaries.ts             BinaryResolver — yt-dlp download/update lifecycle; ffmpeg path resolution
    binaries.integration.test.ts  Integration tests for BinaryResolver
```

Key entry: `dist/index.js` (ESM only).

## Commands

Scripts defined in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-video build      # compile via build.ts
bun run --cwd plugins/plugin-video dev        # same as build (watch not set up)
bun run --cwd plugins/plugin-video typecheck  # tsgo --noEmit
bun run --cwd plugins/plugin-video test       # vitest run
```

## Config / env vars

All vars are optional. The plugin falls back to managed-cache download when no overrides are set.

| Env var | Effect |
|---------|--------|
| `ELIZA_YT_DLP_PATH` | Use this yt-dlp binary instead of the managed cache or system PATH |
| `ELIZA_YT_DLP_PREFER_PATH` | `1` to prefer system PATH yt-dlp over the managed cache |
| `ELIZA_DISABLE_YTDLP_AUTOUPDATE` | `1` to disable automatic yt-dlp self-update on extractor errors |
| `ELIZA_FFMPEG_PATH` | Use this ffmpeg binary; overrides system PATH and `ffmpeg-static` |
| `ELIZA_BINARIES_DIR` | Directory where the managed yt-dlp binary and metadata are cached (default: `<stateDir>/binaries`) |

`ELIZA_STATE_DIR` / `ELIZA_BINARIES_DIR` interact: `BinaryResolver` calls `resolveStateDir()` from `@elizaos/core` to find the default binaries directory.

## How to extend

### Add a new method to VideoService

1. Add the method signature to `IVideoService` in `@elizaos/core` (that interface is the public contract).
2. Implement it in `src/services/video.ts` inside `VideoService`.
3. Wire any needed yt-dlp flags through `this.binaries.runYtDlp(url, flags)`.

### Add a new action that uses VideoService

1. Create `src/actions/my-action.ts` exporting an `Action` object.
2. Inside the action handler, call `runtime.getService<VideoService>(ServiceType.VIDEO)` to get the service.
3. Add the action to the `actions` array in `src/index.ts`.

### Add a new provider

Same pattern: create `src/providers/my-provider.ts`, export a `Provider`, and add it to `providers` in `src/index.ts`.

## Conventions / gotchas

- **Service singleton per runtime.** `VideoService` keeps a serial `processingChain` promise so concurrent `processVideo` calls are queued; don't bypass this.
- **Cache directory is `./content_cache`** relative to the process cwd. Files are never auto-deleted; callers are responsible for cleanup if storage is a concern.
- **yt-dlp auto-update.** On extractor failures matching known error patterns (`Sign in to confirm`, `nsig extraction failed`, `HTTP Error 403`, etc.), `BinaryResolver` re-downloads yt-dlp from the GitHub releases API and retries. This is throttled to once per hour. Set `ELIZA_DISABLE_YTDLP_AUTOUPDATE=1` to disable.
- **ffmpeg is required for audio extraction and thumbnail generation.** The plugin resolves it from `ELIZA_FFMPEG_PATH`, then system PATH, then the `ffmpeg-static` npm package. If none is found, ffmpeg operations throw at first invocation.
- **Transcription fallback requires `ServiceType.TRANSCRIPTION`.** If no subtitles or captions exist and the video is not categorised as Music, `VideoService` calls `runtime.getService<ITranscriptionService>(ServiceType.TRANSCRIPTION)`. Load a plugin that registers an `ITranscriptionService` under `ServiceType.TRANSCRIPTION`, or this path throws "Transcription service not found".
- **Direct MP4 URLs** are detected by extension and bypass yt-dlp for metadata; they use a simple HEAD check and fall back to yt-dlp if unreachable.
- **`BinaryResolver` is a singleton** (`BinaryResolver.instance()`). In tests, call `BinaryResolver.resetForTests()` between cases to avoid state leakage.
- See root `AGENTS.md` for repo-wide rules (logger-only logging, ESM, architecture commandments, naming).
