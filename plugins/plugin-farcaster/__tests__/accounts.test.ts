import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  getFarcasterFid,
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
  } as unknown as IAgentRuntime;
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
});
