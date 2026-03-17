import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { sendMessageAction, WHATSAPP_SEND_MESSAGE_ACTION } from "./sendMessage";

describe("sendMessageAction", () => {
  it("should have correct name and description", () => {
    expect(sendMessageAction.name).toBe(WHATSAPP_SEND_MESSAGE_ACTION);
    expect(sendMessageAction.description).toBe("Send a text message via WhatsApp");
  });

  it("should validate only for whatsapp source", async () => {
    const mockRuntime = {} as IAgentRuntime;

    const whatsappMessage = {
      content: { source: "whatsapp" },
    } as Memory;

    const telegramMessage = {
      content: { source: "telegram" },
    } as Memory;

    expect(await sendMessageAction.validate(mockRuntime, whatsappMessage)).toBe(true);
    expect(await sendMessageAction.validate(mockRuntime, telegramMessage)).toBe(false);
  });

  it("should return error when whatsapp is not configured", async () => {
    const mockRuntime = {
      getSetting: vi.fn().mockReturnValue(undefined),
      composeState: vi.fn().mockResolvedValue({}),
    } as unknown as IAgentRuntime;

    const message = {
      content: { source: "whatsapp" },
    } as Memory;

    const callback = vi.fn();
    const result = await sendMessageAction.handler(
      mockRuntime,
      message,
      undefined,
      undefined,
      callback
    );

    expect(result).toBeDefined();
    if (result) {
      expect(result.success).toBe(false);
      expect(result.error).toBe("WhatsApp not configured");
    }
    expect(callback).toHaveBeenCalledWith({
      text: "WhatsApp is not configured. Missing access token or phone number ID.",
    });
  });

  it("should have valid examples", () => {
    expect(sendMessageAction.examples).toBeDefined();
    expect(sendMessageAction.examples.length).toBeGreaterThan(0);

    for (const example of sendMessageAction.examples) {
      expect(Array.isArray(example)).toBe(true);
      expect(example.length).toBeGreaterThan(0);
    }
  });

  it("should have similes for alternative naming", () => {
    expect(sendMessageAction.similes).toContain("SEND_WHATSAPP");
    expect(sendMessageAction.similes).toContain("WHATSAPP_MESSAGE");
  });
});
