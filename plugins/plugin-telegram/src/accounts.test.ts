import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { resolveTelegramAccount } from "./accounts";

describe("Telegram standard account config resolution", () => {
  it("combines projected account policy with its runtime-only bot token", () => {
    const runtime = {
      character: {
        settings: {
          telegram: {
            accounts: {
              ops: {
                groupPolicy: "allowlist",
                groups: { "-1001": { requireMention: true } },
              },
            },
          },
        },
      },
      getSetting: vi.fn((key: string) =>
        key === "TELEGRAM_ACCOUNT_TOKENS_JSON"
          ? JSON.stringify({ ops: "ops-token" })
          : undefined,
      ),
    } as unknown as IAgentRuntime;

    const account = resolveTelegramAccount(runtime, "ops");

    expect(account.botToken).toBe("ops-token");
    expect(account.config).toMatchObject({
      groupPolicy: "allowlist",
      groups: { "-1001": { requireMention: true } },
    });
  });
});
