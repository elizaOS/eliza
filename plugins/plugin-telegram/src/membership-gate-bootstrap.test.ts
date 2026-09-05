/**
 * Unit coverage for the bootstrap-failure contract of the Telegram
 * membership gate factory: an absent authority service resolves to null
 * (legacy degrade mode) while a connector-account bootstrap FAILURE throws
 * (the service marks the admission gate broken; group admission fails
 * closed). Deterministic mocked harness; the real-PGlite authority vertical
 * lives in __tests__/membership-authority.real.test.ts.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createTelegramMembershipGate } from "./membership-gate";

const membershipLikeService = {
  registerPublisher: vi.fn(),
  authorize: vi.fn(),
};

function runtime(overrides?: {
  getService?: () => unknown;
  getConnectorAccountManager?: () => unknown;
}): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getService: vi.fn(overrides?.getService ?? (() => membershipLikeService)),
    getConnectorAccountManager:
      overrides?.getConnectorAccountManager ??
      (() => ({
        upsertAccount: () =>
          Promise.reject(new Error("connector store unavailable")),
      })),
  } as unknown as IAgentRuntime;
}

describe("createTelegramMembershipGate bootstrap failure contract", () => {
  it("resolves null when the authority service is absent (legacy degrade mode)", async () => {
    const gate = await createTelegramMembershipGate({
      runtime: runtime({ getService: () => null }),
      botTelegramUserId: "42",
    });
    expect(gate).toBeNull();
  });

  it("THROWS on connector-account bootstrap failure (fail-closed contract, not null)", async () => {
    await expect(
      createTelegramMembershipGate({
        runtime: runtime(),
        botTelegramUserId: "42",
      }),
    ).rejects.toThrow(/bootstrap failed/i);
  });
});
