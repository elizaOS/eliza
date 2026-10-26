/**
 * The Discord connector maps the LifeOps send result to a dispatch result:
 * a failed delivery is not accepted (a check-in may try the next channel), a
 * confirmed send with a provider message id carries a receipt, and a send
 * without one stays unconfirmed (no receipt, so it is never a durable send).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordSendMessageResult } from "../domains/discord-service.js";
import { LifeOpsService } from "../service.js";
import { createDiscordConnectorContribution } from "./discord.js";

const runtime = { agentId: "agent-1" } as unknown as IAgentRuntime;
const payload = {
  target: "channel-123",
  targetKind: "channel" as const,
  message: "Morning check-in",
  idempotencyKey: "checkin:1",
};

function sendResult(
  overrides: Partial<DiscordSendMessageResult>,
): DiscordSendMessageResult {
  return {
    provider: "discord",
    side: "owner",
    ok: true,
    channelId: "channel-123",
    deliveryStatus: "sent",
    providerMessageId: null,
    receipt: null,
    ...overrides,
  } as DiscordSendMessageResult;
}

function send(result: DiscordSendMessageResult) {
  vi.spyOn(LifeOpsService.prototype, "sendDiscordMessage").mockResolvedValue(
    result,
  );
  return createDiscordConnectorContribution(runtime).send?.(payload);
}

describe("Discord connector send result", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a failed delivery as not accepted", async () => {
    await expect(
      send(sendResult({ deliveryStatus: "failed" })),
    ).resolves.toMatchObject({
      ok: false,
      acceptance: "not_accepted",
    });
  });

  it("returns the provider message id, not the target, as the receipt", async () => {
    const result = await send(
      sendResult({ deliveryStatus: "sent", providerMessageId: "msg-987" }),
    );
    expect(result).toMatchObject({
      ok: true,
      messageId: "msg-987",
      receipt: {
        provider: "discord",
        providerMessageId: "msg-987",
        idempotencyKey: "checkin:1",
      },
    });
  });

  it("keeps a send without a provider message id unconfirmed", async () => {
    for (const deliveryStatus of ["sent", "sending", "unknown"] as const) {
      const result = await send(sendResult({ deliveryStatus }));
      expect(result).toEqual({ ok: true });
    }
  });
});
