/**
 * Telegram connector receipt tests pin the durable scheduling contract:
 * provider acceptance without a message id is ambiguous, never success.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "../service.js";
import { createTelegramConnectorContribution } from "./telegram.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Telegram connector provider receipts", () => {
  it("returns a durable receipt when Telegram supplies its message id", async () => {
    vi.spyOn(LifeOpsService.prototype, "sendTelegramMessage").mockResolvedValue(
      { ok: true, messageId: "telegram-41" } as never,
    );
    const connector = createTelegramConnectorContribution({
      agentId: "agent-telegram-receipt",
    } as IAgentRuntime);

    await expect(
      connector.send?.({
        target: "telegram:co-parent",
        message: "Approved scheduling message",
        idempotencyKey: "scheduling-message:v1:telegram",
      }),
    ).resolves.toMatchObject({
      ok: true,
      messageId: "telegram-41",
      receipt: {
        provider: "telegram",
        providerMessageId: "telegram-41",
        idempotencyKey: "scheduling-message:v1:telegram",
      },
    });
  });

  it("quarantines provider success without a message id as unknown", async () => {
    vi.spyOn(LifeOpsService.prototype, "sendTelegramMessage").mockResolvedValue(
      { ok: true, messageId: null } as never,
    );
    const connector = createTelegramConnectorContribution({
      agentId: "agent-telegram-missing-receipt",
    } as IAgentRuntime);

    await expect(
      connector.send?.({
        target: "telegram:co-parent",
        message: "Approved scheduling message",
        idempotencyKey: "scheduling-message:v1:telegram-missing",
      }),
    ).resolves.toMatchObject({
      ok: false,
      acceptance: "unknown",
      userActionable: false,
    });
  });
});
