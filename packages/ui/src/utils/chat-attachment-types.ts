/**
 * Bytes held transiently by the composer and sent to the authenticated media
 * write boundary. This shape is never a reference to already-stored media.
 */
export interface TransientClientMediaInput {
  /** Base64-encoded image data (no data URL prefix). */
  data: string;
  mimeType: string;
  name: string;
  /**
   * Optional client-generated downscaled preview (base64, no prefix). The
   * server persists it separately and exposes it as the attachment's
   * `thumbnailUrl` so the chat tile loads a small image while the full
   * resolution opens in the lightbox.
   */
  thumbnail?: {
    data: string;
    mimeType: string;
  };
}

/** Compatibility name for the transient chat-upload wire payload. */
export interface ImageAttachment extends TransientClientMediaInput {
  /**
   * Compatibility-only rich transcript link. New file intake returns
   * `TransientClientMediaInput`, which cannot carry stored-record identity.
   */
  transcriptId?: string;
}
