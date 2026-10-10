# @elizaos/plugin-video

Video download, processing, and transcription service for Eliza agents.

Video processing requires the download/transcoding tools used by the service and a
configured transcription model. Retrieve it as ServiceType.VIDEO. The content_cache
directory is relative to the process working directory; callers own cleanup.

Video processing requires ffmpeg, downloads require yt-dlp, and transcription requires a registered transcription provider. `ELIZA_FFMPEG_PATH` and `ELIZA_YT_DLP_PATH` override binary discovery.

`DISCOVER_MEDIA` returns public YouTube or podcast catalog metadata.
`FIND_CREATOR_UPLOAD` checks a matching verified channel and dates its accessible
regular-upload candidates. It does not guarantee complete or globally latest
coverage. `READ_VIDEO_TRANSCRIPT` uses the existing caption/audio service and
returns the full transcript after processing succeeds; it does not inspect
visuals.

`QUEUE_MEDIA_TRANSCRIPT` and `QUEUE_CREATOR_SUMMARY` use the existing task
queue and save completed transcripts as private documents. `MEDIA_JOB_STATUS`
checks the requester and room before returning state. A queued request is not
a completed transcript. Summaries use native inference plus a separate review
pass; review is probabilistic. Completed jobs use the existing notification
inbox. A connector must supply its own authorized phone delivery adapter;
inbox notification is not proof of handset delivery. Interrupted in-progress
work and uncertain notices are not automatically replayed.

Podcast input may be direct audio, an RSS enclosure, or an episode page with
`og:audio`. Audio bytes use the shared SSRF guard and require a configured
transcription service. Document and video services must be registered before
queuing. Full transcripts stay in DocumentService for ordinary `DOCUMENT`
search/read and source metadata; this avoids a second knowledge store.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-video build  # build
bun run --cwd plugins/plugin-video test   # tests
```
