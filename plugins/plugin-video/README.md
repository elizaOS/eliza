# @elizaos/plugin-video Video Service

The VideoService provides comprehensive video processing capabilities with a focus on efficient handling and transcription:

**Key Features:**
- **Video Download**: Supports both YouTube videos and direct MP4 URLs
- **Format Handling**: 
  - Automatic format detection and conversion
  - MP4 to MP3 conversion for audio processing
  - Support for various video platforms (YouTube, Vimeo)
- **Transcription Pipeline**:
  1. Attempts to extract manual subtitles (SRT format)
  2. Falls back to automatic captions if available
  3. Uses audio transcription as final fallback
- **Performance Optimizations**:
  - Queue-based processing for multiple videos
  - Built-in caching system for processed results
  - Efficient temporary file management
- **Error Handling**:
  - Graceful fallbacks for different transcription methods
  - Comprehensive error reporting
  - Automatic cleanup of temporary files

**Usage Example:**
```typescript
const videoService = runtime.getService<IVideoService>(ServiceType.VIDEO);

// Process a video URL
const result = await videoService.processVideo(videoUrl, runtime);
// Returns: Media object with id, url, title, source, description, and transcript
```
