/**
 * Sender entity-id resolution. Proves inbound messages, slash-command auth,
 * and callback/reaction paths share one UUID, including the default account
 * whose old `scopedTelegramKey` omitted the `default:` prefix.
 */
import { createUniqueUuid, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveTelegramRuntimeEntityId } from "./identity";

function runtime(): IAgentRuntime {
  return {
    agentId: "agent-1",
    getSetting: () => undefined,
  } as unknown as IAgentRuntime;
}

describe("resolveTelegramRuntimeEntityId", () => {
  it("seeds the default account as default:<telegramUserId>, not the bare id", async () => {
    const rt = runtime();
    const inbound = await resolveTelegramRuntimeEntityId(rt, "default", "4242");
    expect(inbound).toBe(createUniqueUuid(rt, "default:4242"));
    expect(inbound).not.toBe(createUniqueUuid(rt, "4242"));
  });

  it("keeps non-default account seeds identical to the historical scoped key", async () => {
    const rt = runtime();
    const accounts = ["acct-a", "bot-2", "other"];
    for (const accountId of accounts) {
      const resolved = await resolveTelegramRuntimeEntityId(
        rt,
        accountId,
        "555001",
      );
      expect(resolved).toBe(createUniqueUuid(rt, `${accountId}:555001`));
    }
  });
});
