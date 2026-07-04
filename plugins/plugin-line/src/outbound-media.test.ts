/**
 * Verifies the LINE connector sends image attachments as native image messages
 * and appends non-image media to the text as a link rather than dropping it
 * (#8876). Mocked send/push — runs offline.
 */
import type { Content } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { LineService } from "./service.js";

// LINE has a dedicated url-based image message but no generic file message,
// which is why non-image media degrades to a text link.

type SendableService = LineService & {
  sendConnectorContent: (to: string, content: Content) => Promise<void>;
  pushMessages: (to: string, messages: unknown[]) => Promise<unknown>;
  sendMessage: (to: string, text: string, opts?: unknown) => Promise<unknown>;
};

function service(): {
  svc: SendableService;
  send: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
} {
  const svc = Object.create(LineService.prototype) as SendableService;
  const send = vi.fn(async () => ({ success: true, chatId: "U1" }));
  const push = vi.fn(async () => ({ success: true, chatId: "U1" }));
  (svc as { sendMessage: unknown }).sendMessage = send;
  (svc as { pushMessages: unknown }).pushMessages = push;
  return { svc, send, push };
}

const TO = "U123456789012345678901234567890";

describe("LINE outbound media", () => {
  it("sends an image attachment as a LINE image message, with text", async () => {
    const { svc, send, push } = service();
    await svc.sendConnectorContent(TO, {
      text: "here you go",
      attachments: [{ id: "img", url: "https://cdn.example.com/cat.png", contentType: "image" }],
    } as Content);

    expect(send).toHaveBeenCalledWith(TO, "here you go", expect.anything());
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][1]).toEqual([
      {
        type: "image",
        originalContentUrl: "https://cdn.example.com/cat.png",
        previewImageUrl: "https://cdn.example.com/cat.png",
      },
    ]);
  });

  it("sends an image-only message (no text) without a text push", async () => {
    const { svc, send, push } = service();
    await svc.sendConnectorContent(TO, {
      text: "",
      attachments: [{ id: "img", url: "https://cdn.example.com/cat.png", contentType: "image" }],
    } as Content);

    expect(send).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("appends non-image media as a link in the text (LINE has no file message)", async () => {
    const { svc, send, push } = service();
    await svc.sendConnectorContent(TO, {
      text: "doc attached",
      attachments: [
        { id: "doc", url: "https://cdn.example.com/report.pdf", contentType: "document" },
      ],
    } as Content);

    expect(send).toHaveBeenCalledWith(
      TO,
      "doc attached\nhttps://cdn.example.com/report.pdf",
      expect.anything()
    );
    // No image message pushed for a non-image attachment.
    expect(push).not.toHaveBeenCalled();
  });

  it("skips a non-https media url (LINE requires https)", async () => {
    const { svc, send, push } = service();
    await svc.sendConnectorContent(TO, {
      text: "hi",
      attachments: [{ id: "x", url: "http://insecure/cat.png", contentType: "image" }],
    } as Content);

    expect(send).toHaveBeenCalledWith(TO, "hi", expect.anything());
    expect(push).not.toHaveBeenCalled();
  });
});
