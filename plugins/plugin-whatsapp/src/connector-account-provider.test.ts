/**
 * Verifies the connector-account surface reports the live Baileys socket state
 * instead of treating the presence of an auth directory as a healthy session.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createWhatsAppConnectorAccountProvider } from "./connector-account-provider";

function runtimeWithStatus(status: "open" | "close" | "connecting" | null): IAgentRuntime {
  return {
    character: {
      settings: { whatsapp: { authDir: "/tmp/paired-whatsapp" } },
    },
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(() => ({ getAccountConnectionStatus: vi.fn(() => status) })),
  } as never as IAgentRuntime;
}

describe("WhatsApp connector account live status", () => {
  it.each([
    ["open", "connected"],
    ["connecting", "pending"],
    ["close", "error"],
    [null, "pending"],
  ] as const)("maps Baileys %s to %s", async (socketStatus, accountStatus) => {
    const provider = createWhatsAppConnectorAccountProvider(runtimeWithStatus(socketStatus));
    const accounts = await provider.listAccounts({} as never);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.status).toBe(accountStatus);
  });
});
