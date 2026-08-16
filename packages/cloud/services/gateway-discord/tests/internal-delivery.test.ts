/** Verifies authenticated proactive Discord delivery and provider nonce receipts. */

import { describe, expect, mock, test } from "bun:test";
import {
  type DiscordInternalDeliveryDependencies,
  deliverInternalDiscordMessage,
  discordReminderNonce,
} from "../src/internal-delivery";

const SECRET = "internal-test-secret";

class MemoryReceipts {
  readonly store = new Map<string, string>();
  failCompletionWrite = false;

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    options: { ex: number; nx?: boolean },
  ): Promise<unknown> {
    if (options.nx && this.store.has(key)) return null;
    if (this.failCompletionWrite && value.includes('"state":"complete"')) {
      throw new Error("completion receipt unavailable");
    }
    this.store.set(key, value);
    return "OK";
  }

  async delete(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }
}

function dependencies(
  receipts: MemoryReceipts,
  sendDirectMessage: DiscordInternalDeliveryDependencies["sendDirectMessage"],
): DiscordInternalDeliveryDependencies {
  return {
    getInternalSecret: () => SECRET,
    receipts,
    sendDirectMessage,
  };
}

function request(
  overrides: Record<string, unknown> = {},
  secret = SECRET,
): Request {
  return new Request("https://gateway-discord.test/internal/deliver", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": secret,
    },
    body: JSON.stringify({
      platform: "discord",
      discordUserId: "1234567890123456",
      text: "take a break",
      idempotencyKey: "task-1:2026-08-15T20:00:00.000Z",
      ...overrides,
    }),
  });
}

describe("Discord internal proactive delivery", () => {
  test("persists the provider receipt and replays without a second send", async () => {
    const receipts = new MemoryReceipts();
    const sendDirectMessage = mock(async () => ({
      accepted: true as const,
      providerMessageId: "discord-message-1",
    }));
    const first = await deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );
    const replay = await deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      success: true,
      idempotencyKey: "task-1:2026-08-15T20:00:00.000Z",
      providerMessageIds: ["discord-message-1"],
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      success: true,
      replayed: true,
      providerMessageIds: ["discord-message-1"],
    });
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]?.[0]).toEqual({
      discordUserId: "1234567890123456",
      text: "take a break",
      nonce: discordReminderNonce("task-1:2026-08-15T20:00:00.000Z"),
    });
    expect(discordReminderNonce("task-1:2026-08-15T20:00:00.000Z")).toMatch(
      /^\d{1,20}$/,
    );
  });

  test("rejects missing auth and model-controlled recipients before egress", async () => {
    const receipts = new MemoryReceipts();
    const sendDirectMessage = mock(async () => ({
      accepted: true as const,
      providerMessageId: "must-not-send",
    }));
    expect(
      (
        await deliverInternalDiscordMessage(request({}, "wrong"), {
          getInternalSecret: () => SECRET,
          receipts,
          sendDirectMessage,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await deliverInternalDiscordMessage(
          request({ discordUserId: "guild:attacker" }),
          {
            getInternalSecret: () => SECRET,
            receipts,
            sendDirectMessage,
          },
        )
      ).status,
    ).toBe(400);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  test("fails before provider egress when durable receipts are unavailable", async () => {
    const receipts = new MemoryReceipts();
    receipts.get = async () => {
      throw new Error("redis unavailable");
    };
    const sendDirectMessage = mock(async () => ({
      accepted: true as const,
      providerMessageId: "must-not-send",
    }));

    const response = await deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      acceptance: "not_accepted",
      retryable: true,
    });
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  test("reports a pre-provider leader miss as retryable and not accepted", async () => {
    const receipts = new MemoryReceipts();
    const sendDirectMessage = mock(async () => ({ accepted: false as const }));
    const response = await deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      retryable: true,
      acceptance: "not_accepted",
    });
    expect(receipts.store).toEqual(new Map());
    await deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );
    expect(sendDirectMessage).toHaveBeenCalledTimes(2);
  });

  test("persists unknown acceptance and never blindly resends", async () => {
    const receipts = new MemoryReceipts();
    const sendDirectMessage = mock(async () => {
      throw new Error("lost provider response");
    });
    const response = await deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );
    const replay = await deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      acceptanceUnknown: true,
      acceptance: "unknown",
    });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      replayed: true,
      acceptanceUnknown: true,
    });
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  test("rejects a concurrent duplicate while one request owns the claim", async () => {
    const receipts = new MemoryReceipts();
    let finishSend: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const sendDirectMessage = mock(async () => {
      markStarted?.();
      await blocked;
      return {
        accepted: true as const,
        providerMessageId: "discord-message-1",
      };
    });
    const firstPromise = deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );
    await started;
    const duplicate = await deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );
    expect(duplicate.status).toBe(409);
    finishSend?.();
    expect((await firstPromise).status).toBe(200);
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  test("turns a post-send receipt write failure into a durable unknown", async () => {
    const receipts = new MemoryReceipts();
    receipts.failCompletionWrite = true;
    const sendDirectMessage = mock(async () => ({
      accepted: true as const,
      providerMessageId: "discord-message-1",
    }));
    const first = await deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );
    const replay = await deliverInternalDiscordMessage(
      request(),
      dependencies(receipts, sendDirectMessage),
    );
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
  });
});
