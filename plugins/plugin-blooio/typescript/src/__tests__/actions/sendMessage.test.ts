import type { HandlerCallback, IAgentRuntime, Media, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sendMessageAction from "../../actions/sendMessage";
import type { BlooioAttachment } from "../../types";

describe("sendMessageAction", () => {
  let mockRuntime: IAgentRuntime;
  let mockBlooioService: {
    sendMessage: (
      chatId: string,
      request: {
        text?: string;
        attachments?: Array<string | BlooioAttachment>;
      }
    ) => Promise<{ status: string }>;
  };
  let mockCallback: HandlerCallback;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBlooioService = {
      sendMessage: vi.fn().mockResolvedValue({ status: "queued" }),
    };
    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockBlooioService),
    } as IAgentRuntime;
    mockCallback = vi.fn();
  });

  it("should have correct metadata", () => {
    expect(sendMessageAction.name).toBe("SEND_MESSAGE");
    expect(sendMessageAction.description).toContain("Blooio");
  });

  it("should validate when chat id is present", async () => {
    const message: Memory = {
      content: { text: "Send a message to +15551234567 saying hello" },
    } as Memory;
    const result = await sendMessageAction.validate(mockRuntime, message);
    expect(result).toBe(true);
  });

  it("should return false when service is missing", async () => {
    mockRuntime.getService = vi.fn().mockReturnValue(null);
    const message: Memory = {
      content: { text: "Send a message to +15551234567" },
    } as Memory;
    const result = await sendMessageAction.validate(mockRuntime, message);
    expect(result).toBe(false);
  });

  it("should send message with extracted text", async () => {
    const message: Memory = {
      content: { text: "Send a message to +15551234567 saying 'Hello there'" },
    } as Memory;

    await sendMessageAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

    expect(mockBlooioService.sendMessage).toHaveBeenCalledWith("+15551234567", {
      text: "Hello there",
      attachments: undefined,
    });
    expect(mockCallback).toHaveBeenCalledWith({
      text: "Message sent successfully to +15551234567",
      success: true,
    });
  });

  it("should include attachments when URLs are present", async () => {
    const message: Memory = {
      content: {
        text: "Send +15551234567 https://example.com/photo.jpg",
      },
    } as Memory;

    await sendMessageAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

    expect(mockBlooioService.sendMessage).toHaveBeenCalledWith("+15551234567", {
      text: undefined,
      attachments: ["https://example.com/photo.jpg"],
    });
  });

  it("should handle errors gracefully", async () => {
    mockBlooioService.sendMessage = vi.fn().mockRejectedValue(new Error("API Error"));
    const message: Memory = {
      content: { text: "Send a message to +15551234567" },
    } as Memory;

    await sendMessageAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

    expect(mockCallback).toHaveBeenCalledWith({
      text: "Failed to send message: API Error",
      success: false,
    });
  });

  it("should include content.attachments (Media[]) in the request", async () => {
    const mediaAttachments: Media[] = [
      { id: "img1", url: "https://example.com/image.png", title: "Photo" },
      {
        id: "vid1",
        url: "https://example.com/video.mp4",
        description: "Video clip",
      },
    ];
    const message: Memory = {
      content: {
        text: "Send to +15551234567",
        attachments: mediaAttachments,
      },
    } as Memory;

    await sendMessageAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

    // When attachments are present but text is empty, text should be undefined (not the default message)
    expect(mockBlooioService.sendMessage).toHaveBeenCalledWith("+15551234567", {
      text: undefined,
      attachments: [
        { url: "https://example.com/image.png", name: "Photo" },
        { url: "https://example.com/video.mp4", name: "Video clip" },
      ],
    });
  });

  it("should combine URLs from text and content.attachments", async () => {
    const mediaAttachments: Media[] = [
      { id: "aud1", url: "https://example.com/audio.mp3", title: "Song" },
    ];
    const message: Memory = {
      content: {
        text: "Send +15551234567 https://example.com/photo.jpg",
        attachments: mediaAttachments,
      },
    } as Memory;

    await sendMessageAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

    expect(mockBlooioService.sendMessage).toHaveBeenCalledWith("+15551234567", {
      text: undefined,
      attachments: [
        "https://example.com/photo.jpg",
        { url: "https://example.com/audio.mp3", name: "Song" },
      ],
    });
  });
});
