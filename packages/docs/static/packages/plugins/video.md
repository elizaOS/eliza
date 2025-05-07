# @elizaos/plugin-video Video Service

## Purpose

The VideoService provides comprehensive video processing capabilities with a focus on efficient handling and transcription.

## Key Features

- Video Download: Supports both YouTube videos and direct MP4 URLs
- Format Handling: Automatic detection/conversion, MP4 to MP3 conversion, support for YouTube and Vimeo
- Transcription Pipeline: Extracts manual subtitles, falls back to automatic captions or audio transcription
- Performance Optimizations: Queue-based processing, built-in caching, efficient temp file management
- Error Handling: Graceful fallbacks, comprehensive error reporting, automatic cleanup

## Example Usage

```typescript
const videoService = runtime.getService<IVideoService>(ServiceType.VIDEO);

// Process a video URL
const result = await videoService.processVideo(videoUrl, runtime);
// Returns: Media object with id, url, title, source, description, and transcript
```
