/** Verifies authenticated proactive Discord delivery and provider nonce receipts. */

import { describe, expect, mock, test } from "bun:test";
import {
  deliverInternalDiscordMessage,
  discordReminderNonce,
} from "../src/internal-delivery";

const SECRET = "internal-test-secret";

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
      discordUserId: "123456789012345678",
      text: "take a break",
      idempotencyKey: "task-1:2026-08-15T20:00:00.000Z",
      ...overrides,
    }),
  });
}

describe("Discord internal proactive delivery", () => {
  test("returns the provider receipt and one stable enforced-nonce input", async () => {
    const sendDirectMessage = mock(async () => ({
      accepted: true as const,
      providerMessageId: "discord-message-1",
    }));
    const first = await deliverInternalDiscordMessage(request(), {
      getInternalSecret: () => SECRET,
      sendDirectMessage,
    });
    const replay = await deliverInternalDiscordMessage(request(), {
      getInternalSecret: () => SECRET,
      sendDirectMessage,
    });

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      success: true,
      idempotencyKey: "task-1:2026-08-15T20:00:00.000Z",
      providerMessageIds: ["discord-message-1"],
    });
    expect(replay.status).toBe(200);
    expect(sendDirectMessage).toHaveBeenCalledTimes(2);
    expect(sendDirectMessage.mock.calls[0]?.[0]).toEqual({
      discordUserId: "123456789012345678",
      text: "take a break",
      nonce: discordReminderNonce("task-1:2026-08-15T20:00:00.000Z"),
    });
    expect(sendDirectMessage.mock.calls[1]?.[0]).toEqual(
      sendDirectMessage.mock.calls[0]?.[0],
    );
    expect(discordReminderNonce("task-1:2026-08-15T20:00:00.000Z")).toMatch(
      /^\d{1,20}$/,
    );
  });

  test("rejects missing auth and model-controlled recipients before egress", async () => {
    const sendDirectMessage = mock(async () => ({
      accepted: true as const,
      providerMessageId: "must-not-send",
    }));
    expect(
      (
        await deliverInternalDiscordMessage(request({}, "wrong"), {
          getInternalSecret: () => SECRET,
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
            sendDirectMessage,
          },
        )
      ).status,
    ).toBe(400);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  test("reports a pre-provider leader miss as retryable and not accepted", async () => {
    const response = await deliverInternalDiscordMessage(request(), {
      getInternalSecret: () => SECRET,
      sendDirectMessage: async () => ({ accepted: false }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      retryable: true,
      acceptance: "not_accepted",
    });
  });

  test("never fabricates success when the provider receipt is unknown", async () => {
    const response = await deliverInternalDiscordMessage(request(), {
      getInternalSecret: () => SECRET,
      sendDirectMessage: async () => {
        throw new Error("lost provider response");
      },
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      acceptanceUnknown: true,
      acceptance: "unknown",
    });
  });
});
