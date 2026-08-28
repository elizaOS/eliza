import { describe, expect, it, vi } from "vitest";
import { EnvAuthProvider } from "./env";

// The provider reads credentials through these two modules; both are mocked
// so the test controls resolution exactly (no process.env influence).
vi.mock("../../utils/settings", () => ({
  getSetting: (
    runtime: { getSetting?: (key: string) => unknown } | undefined,
    key: string,
  ) => runtime?.getSetting?.(key) ?? null,
}));

vi.mock("../accounts", () => ({
  resolveRequestedXAccountId: (
    _runtime: unknown,
    _state: unknown,
    explicitAccountId?: string,
  ) => explicitAccountId ?? "test-account",
}));

const FULL_STATE = {
  TWITTER_API_KEY: "state-api-key",
  TWITTER_API_SECRET_KEY: "state-api-secret",
  TWITTER_ACCESS_TOKEN: "state-access-token",
  TWITTER_ACCESS_TOKEN_SECRET: "state-access-secret",
};

function runtimeWith(settings: Record<string, string>) {
  return {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  } as never;
}

describe("EnvAuthProvider credential assembly", () => {
  it("returns state credentials when all four are present", async () => {
    const provider = new EnvAuthProvider(undefined, FULL_STATE as never);
    await expect(provider.getOAuth1Credentials()).resolves.toEqual({
      appKey: "state-api-key",
      appSecret: "state-api-secret",
      accessToken: "state-access-token",
      accessSecret: "state-access-secret",
    });
  });

  it("falls back to runtime settings for credentials missing from state", async () => {
    const runtime = runtimeWith({
      TWITTER_API_KEY: "env-api-key",
      TWITTER_API_SECRET_KEY: "env-api-secret",
    });
    const provider = new EnvAuthProvider(runtime, {
      TWITTER_ACCESS_TOKEN: "state-access-token",
      TWITTER_ACCESS_TOKEN_SECRET: "state-access-secret",
    } as never);
    await expect(provider.getOAuth1Credentials()).resolves.toEqual({
      appKey: "env-api-key",
      appSecret: "env-api-secret",
      accessToken: "state-access-token",
      accessSecret: "state-access-secret",
    });
  });

  it("treats empty-string state credentials as missing and fails loudly", async () => {
    const runtime = runtimeWith({
      TWITTER_API_KEY: "env-api-key",
      TWITTER_API_SECRET_KEY: "env-api-secret",
      TWITTER_ACCESS_TOKEN: "env-access-token",
      TWITTER_ACCESS_TOKEN_SECRET: "env-access-secret",
    });
    const provider = new EnvAuthProvider(runtime, {
      TWITTER_API_KEY: "",
      TWITTER_API_SECRET_KEY: "",
      TWITTER_ACCESS_TOKEN: "",
      TWITTER_ACCESS_TOKEN_SECRET: "",
    } as never);
    // An explicitly empty state credential is not silently replaced by the
    // setting — the assembly fails loudly rather than risk signing with a
    // half-state/half-env credential mix.
    await expect(provider.getOAuth1Credentials()).rejects.toThrow(
      "Missing required Twitter env credentials",
    );
  });

  it("fails loudly naming every missing variable when none are set", async () => {
    const provider = new EnvAuthProvider(undefined, {} as never);
    await expect(provider.getOAuth1Credentials()).rejects.toThrow(
      "Missing required Twitter env credentials for accountId=test-account: TWITTER_API_KEY, TWITTER_API_SECRET_KEY, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET",
    );
  });

  it("names exactly the missing variable when one is absent", async () => {
    const provider = new EnvAuthProvider(undefined, {
      TWITTER_API_KEY: "k",
      TWITTER_API_SECRET_KEY: "s",
      TWITTER_ACCESS_TOKEN: "t",
    } as never);
    await expect(provider.getOAuth1Credentials()).rejects.toThrow(
      "TWITTER_ACCESS_TOKEN_SECRET",
    );
  });

  it("passes whitespace-only credentials through as configured values", async () => {
    // The missing-credential check is falsy-only: a whitespace-only value is
    // truthy and is forwarded as-is. Downstream OAuth signing sees the exact
    // configured value — the assembly never substitutes or invents one.
    const provider = new EnvAuthProvider(undefined, {
      TWITTER_API_KEY: "   ",
      TWITTER_API_SECRET_KEY: "s",
      TWITTER_ACCESS_TOKEN: "t",
      TWITTER_ACCESS_TOKEN_SECRET: "ts",
    } as never);
    await expect(provider.getOAuth1Credentials()).resolves.toEqual({
      appKey: "   ",
      appSecret: "s",
      accessToken: "t",
      accessSecret: "ts",
    });
  });

  it("exposes the access token through getAccessToken", async () => {
    const provider = new EnvAuthProvider(undefined, FULL_STATE as never);
    await expect(provider.getAccessToken()).resolves.toBe("state-access-token");
  });

  it("surfaces the resolved account id in the failure message", async () => {
    const provider = new EnvAuthProvider(undefined, {
      accountId: "my-account",
    } as never);
    await expect(provider.getOAuth1Credentials()).rejects.toThrow(
      "accountId=my-account",
    );
  });
});
