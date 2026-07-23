/**
 * Registry-status deliverability contract: a bare connector registration
 * (no linked chat contexts, no routable target kinds) must never report
 * connected:true — that phrasing made the live model promise Telegram
 * delivery on a fresh install with nothing linked (#16941).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { registryStatusResult } from "./connector.js";

function runtimeWithRegistration(
  overrides: Partial<{
    contexts: unknown[];
    supportedTargetKinds: string[];
  }> = {},
): IAgentRuntime {
  return {
    getMessageConnectors: () => [
      {
        source: "telegram",
        label: "Telegram",
        capabilities: ["send_message"],
        supportedTargetKinds: overrides.supportedTargetKinds ?? [],
        contexts: overrides.contexts ?? [],
        description: "",
        metadata: {},
      },
    ],
  } as unknown as IAgentRuntime;
}

describe("registryStatusResult deliverability", () => {
  it("reports a bare registration as not connected and says so in prose", () => {
    const result = registryStatusResult(
      runtimeWithRegistration(),
      "telegram",
      "status",
    );
    const status = (result?.data as { status?: { connected?: boolean } })
      ?.status;
    expect(status?.connected).toBe(false);
    expect(result?.text ?? "").toMatch(/no chat or delivery route is linked/i);
    expect(result?.text ?? "").toMatch(/in-app/i);
  });

  it("reports connected when a chat context is linked", () => {
    const result = registryStatusResult(
      runtimeWithRegistration({ contexts: [{ chatId: "123" }] }),
      "telegram",
      "status",
    );
    const status = (result?.data as { status?: { connected?: boolean } })
      ?.status;
    expect(status?.connected).toBe(true);
  });

  it("reports connected when routable target kinds exist", () => {
    const result = registryStatusResult(
      runtimeWithRegistration({ supportedTargetKinds: ["user"] }),
      "telegram",
      "status",
    );
    const status = (result?.data as { status?: { connected?: boolean } })
      ?.status;
    expect(status?.connected).toBe(true);
  });
});
