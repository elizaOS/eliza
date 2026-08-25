/**
 * Verifies that wrapped Baileys messages are normalized through one shared
 * content envelope before type, caption, reply, and media metadata extraction.
 */

import crypto from "node:crypto";
import type { proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { MessageAdapter } from "./message-adapter";

function mediaFields(mimetype: string, overrides: Record<string, unknown> = {}) {
  return {
    mediaKey: crypto.randomBytes(32),
    fileSha256: crypto.randomBytes(32),
    fileEncSha256: crypto.randomBytes(32),
    fileLength: 10,
    mimetype,
    directPath: "/v/t62.7118-24/media.enc",
    ...overrides,
  };
}

function inbound(message: proto.IMessage): proto.IWebMessageInfo {
  return {
    key: { id: "provider-message", remoteJid: "group@g.us", participant: "user@s.whatsapp.net" },
    messageTimestamp: 123,
    message,
  };
}

describe("MessageAdapter wrapped inbound messages", () => {
  it("derives image caption and quote identity from an ephemeral envelope", () => {
    const normalized = new MessageAdapter().toNormalized(
      inbound({
        ephemeralMessage: {
          message: {
            imageMessage: {
              ...mediaFields("image/png"),
              caption: "ephemeral caption",
              contextInfo: {
                stanzaId: "quoted-image-id",
                participant: "quoted-user@s.whatsapp.net",
                quotedMessage: { conversation: "quoted text" },
              },
            },
          },
        },
      })
    );

    expect(normalized).toMatchObject({
      type: "image",
      content: "ephemeral caption",
      replyToId: "quoted-image-id",
      personalMedia: { kind: "image", mimeType: "image/png" },
    });
  });

  it("derives video metadata, caption, and quote identity from a view-once envelope", () => {
    const normalized = new MessageAdapter().toNormalized(
      inbound({
        viewOnceMessage: {
          message: {
            videoMessage: {
              ...mediaFields("video/mp4"),
              caption: "view once caption",
              contextInfo: { stanzaId: "quoted-video-id" },
            },
          },
        },
      })
    );

    expect(normalized).toMatchObject({
      type: "video",
      content: "view once caption",
      replyToId: "quoted-video-id",
      personalMedia: { kind: "video", mimeType: "video/mp4" },
    });
  });

  it("normalizes a document-with-caption filename exactly once", () => {
    const normalized = new MessageAdapter().toNormalized(
      inbound({
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              ...mediaFields("application/pdf"),
              caption: "document caption",
              fileName: "  résumé.pdf  ",
              contextInfo: { stanzaId: "quoted-document-id" },
            },
          },
        },
      })
    );

    expect(normalized).toMatchObject({
      type: "document",
      content: "document caption",
      replyToId: "quoted-document-id",
      personalMedia: {
        kind: "document",
        mimeType: "application/pdf",
        fileName: "résumé.pdf",
      },
    });
  });

  it.each([
    "../secret.pdf",
    "folder\\secret.pdf",
    "C:\\secret.pdf",
    "report\u0000.pdf",
    "report\u202Efdp.exe",
    "report\u2028forged.pdf",
    "report\u2029forged.pdf",
    `${"x".repeat(241)}.pdf`,
    "broken\uD800.pdf",
  ])("rejects an unsafe provider filename: %j", (fileName) => {
    expect(() =>
      new MessageAdapter().toNormalized(
        inbound({ documentMessage: { ...mediaFields("application/pdf"), fileName } })
      )
    ).toThrowError(expect.objectContaining({ code: "WHATSAPP_PERSONAL_MEDIA_FILENAME_INVALID" }));
  });

  it.each([
    "image/png; charset=binary",
    "image",
    "image/ bad",
    `image/${"x".repeat(128)}`,
    "image/\uD800",
  ])("rejects a malformed provider MIME declaration: %j", (mimetype) => {
    expect(() =>
      new MessageAdapter().toNormalized(inbound({ imageMessage: mediaFields(mimetype) }))
    ).toThrowError(expect.objectContaining({ code: "WHATSAPP_PERSONAL_MEDIA_METADATA_INVALID" }));
  });
});
