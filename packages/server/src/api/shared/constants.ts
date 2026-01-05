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
 * Valid transport types for messaging API endpoints
 * - "http": Wait for complete agent response (sync)
 * - "sse": SSE streaming response
 * - "websocket": Return immediately, agent response via WebSocket (default)
 */
export const TRANSPORT_TYPES = ['http', 'sse', 'websocket'] as const;

/**
 * Type for transport parameter
 */
export type TransportType = (typeof TRANSPORT_TYPES)[number];

/**
 * Default transport type for backward compatibility
 */
export const DEFAULT_TRANSPORT: TransportType = 'websocket';

/**
 * Legacy response mode aliases for backward compatibility
 * Maps old mode names to new transport types
 */
export const LEGACY_MODE_MAP: Record<string, TransportType> = {
  sync: 'http',
  stream: 'sse',
  websocket: 'websocket',
};

/**
 * @deprecated Use TRANSPORT_TYPES instead
 */
export const RESPONSE_MODES = TRANSPORT_TYPES;

/**
 * @deprecated Use TransportType instead
 */
export type ResponseMode = TransportType;

/**
 * @deprecated Use DEFAULT_TRANSPORT instead
 */
export const DEFAULT_RESPONSE_MODE = DEFAULT_TRANSPORT;
