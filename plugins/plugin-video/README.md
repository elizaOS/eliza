# @elizaos/plugin-video

Video download, processing, and transcription plugin for elizaOS agents.

## What it does

This plugin adds a `VideoService` to any Eliza agent's service registry. Once loaded, other plugins and actions can call `runtime.getService<IVideoService>(ServiceType.VIDEO)` to:

- **Download video** from YouTube, Vimeo, or any direct MP4 URL.
- **Extract audio** from a video file (MP4 → MP3 via ffmpeg).
- **Generate thumbnails** from a specific timestamp.
- **Convert video** to a different format, resolution, bitrate, codec, or time range.
- **Fetch available formats** for a URL via yt-dlp.
- **Process a video URL end-to-end** into a `Media` object with title, description, source, and a full transcript. Transcription priority:
  1. Manual subtitles (SRT), if available.
  2. Automatic captions, if available.
  3. Audio transcription via `ServiceType.TRANSCRIPTION` (requires a transcription plugin such as `@elizaos/plugin-node`).

Results are cached under `./content_cache/` by content hash. yt-dlp is automatically kept up to date: on known extractor failures the plugin re-downloads the latest yt-dlp release from GitHub and retries.

## Enabling the plugin

Add `@elizaos/plugin-video` to the agent's plugin list in its character file or runtime configuration:

```json
{
  "plugins": ["@elizaos/plugin-video"]
}
```

## Usage

```typescript
import { IVideoService, ServiceType } from "@elizaos/core";

// Inside an action or provider handler:
const videoService = runtime.getService<IVideoService>(ServiceType.VIDEO);
if (!videoService) throw new Error("plugin-video not loaded");

// Fetch full transcript + metadata:
const media = await videoService.processVideo("https://www.youtube.com/watch?v=...", runtime);
// media.text contains the transcript
// media.title, media.source, media.description have metadata

// Download only:
const filePath = await videoService.downloadVideo("https://www.youtube.com/watch?v=...");

// Extract audio from a local file:
const mp3Path = await videoService.extractAudio("/path/to/video.mp4");
```

## Required environment variables

None are required. The plugin resolves binaries automatically.

| Variable | Purpose | Default |
|----------|---------|---------|
| `ELIZA_YT_DLP_PATH` | Path to a specific yt-dlp binary | Auto-resolved |
| `ELIZA_YT_DLP_PREFER_PATH` | `1` to prefer system `yt-dlp` over the managed cache | `0` |
| `ELIZA_DISABLE_YTDLP_AUTOUPDATE` | `1` to disable automatic yt-dlp updates on failure | `0` |
| `ELIZA_FFMPEG_PATH` | Path to a specific ffmpeg binary | Auto-resolved |
| `ELIZA_BINARIES_DIR` | Directory where managed yt-dlp is cached | `<stateDir>/binaries` |

## System dependencies

- **ffmpeg** — required for audio extraction, thumbnail generation, and video conversion. Resolved from `ELIZA_FFMPEG_PATH`, then system PATH, then the bundled `ffmpeg-static` npm package.
- **yt-dlp** — required for YouTube/Vimeo downloads and subtitle extraction. Resolved from `ELIZA_YT_DLP_PATH`, system PATH, or automatically downloaded and cached from GitHub releases.
- **Transcription service** — needed only for the audio-transcription fallback path. Any plugin that registers `ServiceType.TRANSCRIPTION` (e.g. `@elizaos/plugin-node`) will work.
