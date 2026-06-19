/**
 * Chat UI constants for message attachments. Values match `@elizaos/core`
 * `ContentType` (see published `dist/types/primitives.d.ts`) so API payloads
 * line up without pulling the core package into the browser bundle.
 */
export const ContentType = {
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  DOCUMENT: "document",
  LINK: "link",
} as const;

export type ContentType = (typeof ContentType)[keyof typeof ContentType];

/** Shape used by chat components for rendered attachments; fields optional where the API omits them. */
export interface ChatMediaAttachment {
  id: string;
  url: string;
  contentType?: ContentType;
  title?: string;
  description?: string;
  source?: string;
  text?: string;
}
