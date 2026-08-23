/**
 * Verifies safe sort comparator behavior in WhatsAppConnectorService when timestamps
 * in known targets and connector messages contain NaN or invalid values.
 */

import { describe, expect, it } from "vitest";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { WhatsAppConnectorService } from "../src/runtime-service";

describe("WhatsAppConnectorService safe sort comparators", () => {
  it("sorts known targets safely when lastMessageAt contains NaN", () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      registerMessageConnector: () => {},
      registerSendHandler: () => {},
    } as unknown as IAgentRuntime;

    const service = new WhatsAppConnectorService(runtime, {
      transport: "cloudapi",
      phoneNumberId: "12345",
      accessToken: "test-token",
    });

    (service as any).knownTargets.set("target-1", {
      accountId: "acc-1",
      chatId: "+11111111111",
      senderId: "+11111111111",
      lastMessageAt: NaN,
      isGroup: false,
    });

    (service as any).knownTargets.set("target-2", {
      accountId: "acc-1",
      chatId: "+22222222222",
      senderId: "+22222222222",
      lastMessageAt: 5000,
      isGroup: false,
    });

    const targets = service.listKnownTargets();
    expect(targets).toHaveLength(2);
    expect(targets[0]?.chatId).toBe("+22222222222"); // valid timestamp first
    expect(targets[1]?.chatId).toBe("+11111111111"); // NaN fallback to 0
  });
});
