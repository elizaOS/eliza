import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { FarcasterService } from "../services/FarcasterService";
import {
  getFarcasterFid,
  listFarcasterAccountIds,
  readFarcasterAccountId,
  resolveDefaultFarcasterAccountId,
  validateFarcasterConfig,
} from "../utils/config";

function runtime(settings: Record<string, string>): IAgentRuntime {
  return {
    character: { settings: {} },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  } as IAgentRuntime;
}

describe("Farcaster account config", () => {
  it("preserves legacy env settings as the default account", () => {
    const rt = runtime({
      FARCASTER_FID: "123",
      FARCASTER_SIGNER_UUID: "signer-default",
      FARCASTER_NEYNAR_API_KEY: "key-default",
    });

    expect(resolveDefaultFarcasterAccountId(rt)).toBe("default");
    expect(getFarcasterFid(rt)).toBe(123);
    expect(validateFarcasterConfig(rt).accountId).toBe("default");
  });

  it("resolves a named account from FARCASTER_ACCOUNTS", () => {
    const rt = runtime({
      FARCASTER_DEFAULT_ACCOUNT_ID: "brand",
      FARCASTER_ACCOUNTS: JSON.stringify({
        brand: {
          FARCASTER_FID: 456,
          FARCASTER_SIGNER_UUID: "signer-brand",
          FARCASTER_NEYNAR_API_KEY: "key-brand",
        },
      }),
    });

    const config = validateFarcasterConfig(rt);
    expect(config.accountId).toBe("brand");
    expect(config.FARCASTER_FID).toBe(456);
  });

  it("ignores malformed FARCASTER_ACCOUNTS JSON instead of crashing account discovery", () => {
    const rt = runtime({
      FARCASTER_ACCOUNTS: "{not json",
    });

    expect(listFarcasterAccountIds(rt)).toEqual(["default"]);
    expect(resolveDefaultFarcasterAccountId(rt)).toBe("default");
  });

  it("does not leak legacy env credentials into named account validation", () => {
    const rt = runtime({
      FARCASTER_FID: "123",
      FARCASTER_SIGNER_UUID: "signer-default",
      FARCASTER_NEYNAR_API_KEY: "key-default",
      FARCASTER_ACCOUNTS: JSON.stringify({
        brand: {
          FARCASTER_FID: 456,
        },
      }),
    });

    expect(() => validateFarcasterConfig(rt, "brand")).toThrow("FARCASTER_SIGNER_UUID");
    expect(() => validateFarcasterConfig(rt, "brand")).toThrow("FARCASTER_NEYNAR_API_KEY");
  });

  it("reads account IDs from nested Farcaster metadata and normalizes whitespace", () => {
    expect(
      readFarcasterAccountId(
        { accountId: " " },
        { data: { farcaster: { accountId: "  brand  " } } }
      )
    ).toBe("brand");
  });

  it("keeps active managers keyed by agent and account", () => {
    const service = new FarcasterService() as {
      agents: Map<string, unknown>;
      getActiveManagers: FarcasterService["getActiveManagers"];
      getManagerForAccount: FarcasterService["getManagerForAccount"];
      getManagersForAgent: FarcasterService["getManagersForAgent"];
    };
    const defaultManager = { config: { accountId: "default" } };
    const brandManager = { config: { accountId: "brand" } };

    service.agents.set("agent-1", {
      defaultAccountId: "default",
      managers: new Map([
        ["default", defaultManager],
        ["brand", brandManager],
      ]),
      messageServices: new Map(),
      castServices: new Map(),
    });

    const managers = service.getActiveManagers.call(service);

    expect(managers.get("agent-1:default")).toBe(defaultManager);
    expect(managers.get("agent-1:brand")).toBe(brandManager);
    expect(service.getManagerForAccount.call(service, "brand", "agent-1")).toBe(brandManager);
    expect(Array.from(service.getManagersForAgent.call(service, "agent-1").keys())).toEqual([
      "default",
      "brand",
    ]);
  });
});
