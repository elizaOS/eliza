/**
 * Storybook states for the MessageAttachments chat component used by message
 * rendering, attachments, and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { MessageAttachment } from "../../api/client-types-chat";
import { MessageAttachments } from "./MessageAttachments";

/**
 * Visual story coverage for every chat attachment preview state — the
 * "previews of everything" surface (#8876). The story-gate renders + screenshots
 * each, so every kind (image / audio / video / PDF inline + download-fallback /
 * text-code / generic document / multiple) stays regression-guarded. Fixtures
 * mirror the (passing) MessageAttachments render tests, so each story renders.
 */

const HASH = "a".repeat(64);

const meta = {
  title: "Chat/MessageAttachments",
  component: MessageAttachments,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
} satisfies Meta<typeof MessageAttachments>;

export default meta;
type Story = StoryObj<typeof meta>;

function att(overrides: Partial<MessageAttachment>): MessageAttachment {
  return { id: "a", url: "https://example.com/x", ...overrides };
}

/** Image → inline tile (opens a lightbox on click). */
export const Image: Story = {
  args: {
    attachments: [
      att({
        id: "img",
        url: "https://example.com/cat.png",
        contentType: "image",
        title: "cat.png",
      }),
    ],
  },
};

/** Audio → native player. */
export const Audio: Story = {
  args: {
    attachments: [
      att({
        id: "aud",
        url: "https://example.com/clip.mp3",
        contentType: "audio",
        title: "clip.mp3",
      }),
    ],
  },
};

/** Video → native player. */
export const Video: Story = {
  args: {
    attachments: [
      att({
        id: "vid",
        url: "https://example.com/clip.mp4",
        contentType: "video",
        title: "clip.mp4",
      }),
    ],
  },
};

/** PDF with a same-origin served URL → inline browser viewer (sandboxed). */
export const PdfInline: Story = {
  args: {
    attachments: [
      att({
        id: "pdf",
        url: `/api/media/${HASH}.pdf`,
        contentType: "document",
        title: "report.pdf",
      }),
    ],
  },
};

/** PDF as a data: URL → download-only card (no inline iframe). */
export const PdfDownloadFallback: Story = {
  args: {
    attachments: [
      att({
        id: "pdf-data",
        url: "data:application/pdf;base64,JVBERi0xLjQK",
        contentType: "document",
        title: "inline.pdf",
      }),
    ],
  },
};

/** Text/code with extracted text → inline CodeBlock preview. */
export const TextCode: Story = {
  args: {
    attachments: [
      att({
        id: "code",
        url: "https://example.com/snippet.ts",
        contentType: "document",
        title: "snippet.ts",
        text: "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      }),
    ],
  },
};

/** Generic (non-previewable) document → download card. */
export const Document: Story = {
  args: {
    attachments: [
      att({
        id: "doc",
        url: "https://example.com/archive.zip",
        contentType: "document",
        title: "archive.zip",
      }),
    ],
  },
};

/**
 * 3D model (.glb/.gltf) → inline WebGL viewer (three.js, lazily loaded,
 * auto-framed + auto-rotating) with a download affordance in the header. When
 * WebGL is unavailable or the model can't load, it degrades to a download card
 * so the bytes are never walled off. This story uses a served-relative URL that
 * resolves to a fast 404 in headless/Storybook, so it deterministically renders
 * the download fallback (the live 3D render needs a real model + GPU).
 */
export const Model3D: Story = {
  args: {
    attachments: [
      att({
        id: "model",
        url: `/api/media/${HASH}.glb`,
        contentType: "document",
        title: "scene.glb",
      }),
    ],
  },
};

/** Several attachments of mixed kinds in one message. */
export const Multiple: Story = {
  args: {
    attachments: [
      att({
        id: "img",
        url: "https://example.com/photo.jpg",
        contentType: "image",
        title: "photo.jpg",
      }),
      att({
        id: "pdf",
        url: `/api/media/${HASH}.pdf`,
        contentType: "document",
        title: "spec.pdf",
      }),
      att({
        id: "aud",
        url: "https://example.com/voice.mp3",
        contentType: "audio",
        title: "voice.mp3",
      }),
    ],
  },
};
