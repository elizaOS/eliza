import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendWhatsAppMessage } from "../src/actions";

// ---------------------------------------------------------------------------
// Mock runtime
// ---------------------------------------------------------------------------

function createMockRuntime(hasWhatsApp = true) {
  return {
    hasService: vi.fn().mockReturnValue(hasWhatsApp),
    sendMessageToTarget: vi.fn().mockResolvedValue(undefined),
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as Parameters<typeof sendWhatsAppMessage.handler>[0];
}

function stubMessage(
  roomId = "room-1" as `${string}-${string}-${string}-${string}-${string}`,
) {
  return { roomId } as Parameters<typeof sendWhatsAppMessage.handler>[1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendWhatsAppMessage action", () => {
  describe("metadata", () => {
    it("has the correct name", () => {
      expect(sendWhatsAppMessage.name).toBe("SEND_WHATSAPP_MESSAGE");
    });

    it("includes similes", () => {
      expect(sendWhatsAppMessage.similes).toContain("WHATSAPP_MESSAGE");
    });
  });

  // -----------------------------------------------------------------------
  // validate()
  // -----------------------------------------------------------------------

  describe("validate()", () => {
    it("returns true when the whatsapp service exists", async () => {
      const runtime = createMockRuntime(true);
      const result = await sendWhatsAppMessage.validate(runtime, stubMessage());
      expect(result).toBe(true);
      expect(runtime.hasService).toHaveBeenCalledWith("whatsapp");
    });

    it("returns false when the whatsapp service does not exist", async () => {
      const runtime = createMockRuntime(false);
      const result = await sendWhatsAppMessage.validate(runtime, stubMessage());
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // handler()
  // -----------------------------------------------------------------------

  describe("handler()", () => {
    let runtime: ReturnType<typeof createMockRuntime>;
    let callback: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      runtime = createMockRuntime();
      callback = vi.fn().mockResolvedValue(undefined);
    });

    it("calls callback with error when phoneNumber is missing", async () => {
      const result = await sendWhatsAppMessage.handler(
        runtime,
        stubMessage(),
        undefined, // state
        { parameters: { message: "hello" } }, // no phoneNumber
        callback,
      );

      expect(result).toEqual({ success: false });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].text).toMatch(/need both/i);
      expect(runtime.logger.warn).toHaveBeenCalled();
    });

    it("calls callback with error when message is missing", async () => {
      const result = await sendWhatsAppMessage.handler(
        runtime,
        stubMessage(),
        undefined,
        { parameters: { phoneNumber: "+1234567890" } },
        callback,
      );

      expect(result).toEqual({ success: false });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].text).toMatch(/need both/i);
    });

    it("calls callback with error when both params are missing (no options)", async () => {
      const result = await sendWhatsAppMessage.handler(
        runtime,
        stubMessage(),
        undefined,
        undefined,
        callback,
      );

      expect(result).toEqual({ success: false });
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("calls callback with validation error for a phone number that is too short", async () => {
      const result = await sendWhatsAppMessage.handler(
        runtime,
        stubMessage(),
        undefined,
        { parameters: { phoneNumber: "123", message: "hi" } },
        callback,
      );

      expect(result).toEqual({ success: false });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].text).toMatch(/doesn't look valid/i);
      // sendMessageToTarget should NOT have been called
      expect(runtime.sendMessageToTarget).not.toHaveBeenCalled();
    });

    it("calls runtime.sendMessageToTarget with correct JID for valid params", async () => {
      const result = await sendWhatsAppMessage.handler(
        runtime,
        stubMessage(
          "room-abc-def-ghi-jkl" as `${string}-${string}-${string}-${string}-${string}`,
        ),
        undefined,
        { parameters: { phoneNumber: "+1234567890", message: "Hello there!" } },
        callback,
      );

      expect(result).toEqual({ success: true });
      expect(runtime.sendMessageToTarget).toHaveBeenCalledTimes(1);

      const [target, content] = runtime.sendMessageToTarget.mock.calls[0];
      expect(target.source).toBe("whatsapp");
      expect(target.channelId).toBe("1234567890@s.whatsapp.net");
      expect(target.roomId).toBe("room-abc-def-ghi-jkl");
      expect(content.text).toBe("Hello there!");

      // Callback should report success
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].text).toMatch(/message sent/i);
    });

    it("strips non-numeric chars from phone number before forming JID", async () => {
      await sendWhatsAppMessage.handler(
        runtime,
        stubMessage(),
        undefined,
        { parameters: { phoneNumber: "+1 (234) 567-890", message: "test" } },
        callback,
      );

      const [target] = runtime.sendMessageToTarget.mock.calls[0];
      expect(target.channelId).toBe("1234567890@s.whatsapp.net");
    });

    it("handles send failure gracefully", async () => {
      runtime.sendMessageToTarget.mockRejectedValueOnce(
        new Error("Network error"),
      );

      const result = await sendWhatsAppMessage.handler(
        runtime,
        stubMessage(),
        undefined,
        { parameters: { phoneNumber: "+1234567890", message: "hello" } },
        callback,
      );

      expect(result).toEqual({ success: false });
      expect(runtime.logger.error).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].text).toMatch(/failed to send/i);
      expect(callback.mock.calls[0][0].text).toContain("Network error");
    });

    it("handles send failure with non-Error objects", async () => {
      runtime.sendMessageToTarget.mockRejectedValueOnce("string-error");

      const result = await sendWhatsAppMessage.handler(
        runtime,
        stubMessage(),
        undefined,
        { parameters: { phoneNumber: "+1234567890", message: "hello" } },
        callback,
      );

      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("string-error");
    });

    it("works without a callback (no throw)", async () => {
      // No callback passed — should not throw
      const result = await sendWhatsAppMessage.handler(
        runtime,
        stubMessage(),
        undefined,
        { parameters: { phoneNumber: "+1234567890", message: "hello" } },
        undefined, // no callback
      );

      expect(result).toEqual({ success: true });
      expect(runtime.sendMessageToTarget).toHaveBeenCalledTimes(1);
    });

    it("works without a callback when params are missing", async () => {
      const result = await sendWhatsAppMessage.handler(
        runtime,
        stubMessage(),
        undefined,
        undefined,
        undefined,
      );

      expect(result).toEqual({ success: false });
      // Should not throw even without a callback
    });
  });
});
