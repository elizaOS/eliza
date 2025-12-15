/**
 * Shared constants for the API server
 */

/**
 * Maximum file size allowed for uploads (50MB)
 * Used across various endpoints including audio processing,
 * media uploads, and multer configurations
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Maximum file size in human-readable format
 */
export const MAX_FILE_SIZE_DISPLAY = '50MB';

/**
 * Valid MIME types for audio files
 */
export const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
  'audio/x-wav',
  'audio/wave',
] as const;

/**
 * Valid MIME types for media files (includes audio, images, documents)
 */
export const ALLOWED_MEDIA_MIME_TYPES = [
  ...ALLOWED_AUDIO_MIME_TYPES,
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'application/pdf',
  'text/plain',
] as const;

/**
 * Valid response modes for messaging API endpoints
 * - "sync": Wait for complete agent response
 * - "stream": SSE streaming response
 * - "websocket": Return immediately, agent response via WebSocket (default)
 */
export const RESPONSE_MODES = ['sync', 'stream', 'websocket'] as const;

/**
 * Type for response mode parameter
 */
export type ResponseMode = (typeof RESPONSE_MODES)[number];

/**
 * Default response mode for backward compatibility
 */
export const DEFAULT_RESPONSE_MODE: ResponseMode = 'websocket';
