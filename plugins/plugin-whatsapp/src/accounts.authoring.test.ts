/** Proves WhatsApp's account facade preserves its established lowercase policy and default selection. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { normalizeAccountId, resolveDefaultWhatsAppAccountId } from "./accounts";

function runtime(accounts: Record<string, object>): IAgentRuntime {
  return {
    character: { settings: { whatsapp: { accounts } } },
    getSetting: vi.fn(() => null),
  } as unknown as IAgentRuntime;
}

describe("WhatsApp canonical account authoring facade", () => {
  it("keeps the existing trim-and-lowercase normalization contract", () => {
    expect(normalizeAccountId(" Team-Bot ")).toBe("team-bot");
    expect(normalizeAccountId(" ")).toBe("default");
  });

  it("selects the first normalized account when no default exists", () => {
    expect(resolveDefaultWhatsAppAccountId(runtime({ " Team-Bot ": {}, Alpha: {} }))).toBe("alpha");
  });
});
