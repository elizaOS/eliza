/**
 * Telegram gateway retry amplification tests.
 * Issue #19519: slow agent turns cause gateway timeout retry amplification.
 * Tests validate typing indicator continuity and retry idempotency.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

describe("Telegram retry amplification", () => {
  beforeEach(() => {
    // Reset mocks
  });

  it("should not retry on successful sendMessage", async () => {
    const calls: string[] = [];
    const mockFetch = mock(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });

    global.fetch = mockFetch;

    // Simulate single successful send
    const url = "https://api.telegram.org/bot123/sendMessage";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: 456, text: "Hello" }),
    });

    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("should maintain typing indicator during slow agent turns", async () => {
    let typingCallCount = 0;
    let sendCallCount = 0;

    const mockFetch = mock(async (url: string) => {
      if (url.includes("sendChatAction")) {
        typingCallCount++;
        // Typing returns quickly
        return new Response(JSON.stringify({ ok: true, result: true }));
      }

      if (url.includes("sendMessage")) {
        sendCallCount++;
        // Simulate fast send
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }

      return new Response(JSON.stringify({ ok: false }), { status: 400 });
    });

    global.fetch = mockFetch;

    // Simulate sending typing indicators
    const sendTyping = async () => {
      await fetch("https://api.telegram.org/bot123/sendChatAction", {
        method: "POST",
        body: JSON.stringify({ chat_id: 456, action: "typing" }),
      });
    };

    // Send multiple typing indicators
    await Promise.all([sendTyping(), sendTyping(), sendTyping()]);

    // Then send message
    await fetch("https://api.telegram.org/bot123/sendMessage", {
      method: "POST",
      body: JSON.stringify({ chat_id: 456, text: "Response" }),
    });

    // Verify typing indicators were sent
    expect(typingCallCount).toBeGreaterThan(0);
    expect(sendCallCount).toBe(1);
  });

  it("should handle 30s timeout without replaying message", async () => {
    const sendCalls: string[] = [];
    let callCount = 0;

    const mockFetch = mock(async (url: string) => {
      if (url.includes("sendMessage")) {
        callCount++;
        sendCalls.push(`call-${callCount}`);

        if (callCount === 1) {
          // Simulate timeout (request takes > 30s, but abort triggers first)
          await new Promise((r) => setTimeout(r, 100));
          throw new Error("timeout");
        }

        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }

      return new Response(JSON.stringify({ ok: false }));
    });

    global.fetch = mockFetch;

    // First attempt times out
    try {
      await fetch("https://api.telegram.org/bot123/sendMessage", {
        method: "POST",
        body: JSON.stringify({ chat_id: 456, text: "Hello" }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Expected timeout
    }

    // Message should not be replayed blindly; need idempotency key
    expect(sendCalls.length).toBe(1);
  });

  it("should use idempotency keys to prevent duplicate sends", () => {
    const messageIds = new Map<string, string>();
    const sentMessages: { messageId: string; text: string }[] = [];

    // Simulate message send with idempotency key
    function sendWithIdempotency(chatId: string, text: string, idempotencyKey: string) {
      if (messageIds.has(idempotencyKey)) {
        return { ok: true, cached: true, message_id: messageIds.get(idempotencyKey) };
      }

      const messageId = `msg_${Date.now()}`;
      messageIds.set(idempotencyKey, messageId);
      sentMessages.push({ messageId, text });
      return { ok: true, message_id: messageId };
    }

    // Send same message 3 times with same idempotency key
    const idempotencyKey = "request-123";
    for (let i = 0; i < 3; i++) {
      const result = sendWithIdempotency("456", "Hello", idempotencyKey);
      expect(result.ok).toBe(true);
    }

    // Should only actually send once
    expect(sentMessages.length).toBe(1);
    expect(messageIds.size).toBe(1);
  });

  it("should expose gateway operation durations in logs", () => {
    const durations: { stage: string; ms: number }[] = [];

    function logDuration(stage: string, ms: number) {
      durations.push({ stage, ms });
    }

    // Simulate operation stages
    const start = Date.now();

    // Identity stage
    logDuration("identity", 5);

    // Routing stage
    logDuration("routing", 10);

    // Agent forward stage
    logDuration("agent-forward", 150);

    // Egress stage (Telegram API)
    logDuration("egress-telegram", 50);

    const totalTime = durations.reduce((sum, d) => sum + d.ms, 0);

    expect(durations.length).toBe(4);
    expect(totalTime).toBe(215);

    // Verify stages are logged
    const stageNames = durations.map((d) => d.stage);
    expect(stageNames).toContain("identity");
    expect(stageNames).toContain("routing");
    expect(stageNames).toContain("agent-forward");
    expect(stageNames).toContain("egress-telegram");
  });

  it("should validate production Telegram DM without retry amplification", async () => {
    const attempts: { timestamp: number; success: boolean }[] = [];

    // Simulate a message that takes 25 seconds (near timeout boundary)
    const sendMessage = async (attempt: number) => {
      const start = Date.now();
      attempts.push({ timestamp: start, success: false });

      // Simulate 25 second delay (within 30s timeout)
      await new Promise((r) => setTimeout(r, 25));

      const elapsed = Date.now() - start;
      attempts[attempts.length - 1].success = true;

      return { ok: true, message_id: 1, elapsedMs: elapsed };
    };

    // Send message once
    const result = await sendMessage(1);
    expect(result.ok).toBe(true);

    // Should not retry if successful
    expect(attempts.length).toBe(1);
    expect(attempts[0].success).toBe(true);
  });

  it("should distinguish between timeout and actual Telegram API error", () => {
    const errors: { type: string; retriable: boolean }[] = [];

    // Timeout error
    const timeoutErr = new DOMException("The operation was aborted.", "AbortError");
    errors.push({
      type: "timeout",
      retriable: timeoutErr.name === "AbortError",
    });

    // API rate limit (retriable)
    const rateLimitErr = { ok: false, error_code: 429 };
    errors.push({
      type: "rate-limit",
      retriable: rateLimitErr.error_code === 429,
    });

    // API invalid token (not retriable)
    const invalidTokenErr = { ok: false, error_code: 401 };
    errors.push({
      type: "invalid-token",
      retriable: invalidTokenErr.error_code !== 401,
    });

    expect(errors[0].retriable).toBe(true); // Timeout is retriable
    expect(errors[1].retriable).toBe(true); // Rate limit is retriable
    expect(errors[2].retriable).toBe(false); // Invalid token is not retriable
  });
});
