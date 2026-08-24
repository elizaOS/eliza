/**
 * Unit coverage for per-account Instagram connector config resolution: account
 * id normalization, multi-source account id extraction, and the three-source
 * (env / character / INSTAGRAM_ACCOUNTS) merge that supplies InstagramService
 * its credentials. A wrong id or a leaked env fallback onto a named account
 * would route the connector at the wrong account or leak the default
 * account's credentials — real behavioral hazards worth pinning.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    code?: string;
    severity?: string;
    context?: unknown;
    constructor(
      message: string,
      opts?: { code?: string; severity?: string; context?: unknown; cause?: unknown }
    ) {
      super(message);
      this.code = opts?.code;
      this.severity = opts?.severity;
      this.context = opts?.context;
    }
  },
}));

import {
  DEFAULT_INSTAGRAM_ACCOUNT_ID,
  listInstagramAccountIds,
  normalizeInstagramAccountId,
  readInstagramAccountId,
  resolveDefaultInstagramAccountId,
  resolveInstagramAccountConfig,
} from "./accounts";

describe("normalizeInstagramAccountId", () => {
  it("falls back to the default id for non-string input", () => {
    expect(normalizeInstagramAccountId(undefined)).toBe(DEFAULT_INSTAGRAM_ACCOUNT_ID);
    expect(normalizeInstagramAccountId(null)).toBe(DEFAULT_INSTAGRAM_ACCOUNT_ID);
    expect(normalizeInstagramAccountId(42)).toBe(DEFAULT_INSTAGRAM_ACCOUNT_ID);
  });

  it("trims whitespace", () => {
    expect(normalizeInstagramAccountId("  brand  ")).toBe("brand");
  });

  it("falls back to the default id for blank strings", () => {
    expect(normalizeInstagramAccountId("   ")).toBe(DEFAULT_INSTAGRAM_ACCOUNT_ID);
  });
});

describe("readInstagramAccountId", () => {
  it("returns undefined when no source carries an account id", () => {
    expect(readInstagramAccountId()).toBeUndefined();
    expect(readInstagramAccountId({ data: {} })).toBeUndefined();
  });

  it("reads a top-level accountId", () => {
    expect(readInstagramAccountId({ accountId: "brand" })).toBe("brand");
  });

  it("reads a nested parameters.accountId", () => {
    expect(readInstagramAccountId({ parameters: { accountId: "brand" } })).toBe("brand");
  });

  it("reads data.accountId", () => {
    expect(readInstagramAccountId({ data: { accountId: "brand" } })).toBe("brand");
  });

  it("reads data.instagram.accountId", () => {
    expect(readInstagramAccountId({ data: { instagram: { accountId: "brand" } } })).toBe("brand");
  });

  it("reads metadata.accountId", () => {
    expect(readInstagramAccountId({ metadata: { accountId: "brand" } })).toBe("brand");
  });

  it("skips blank values and falls through to the next source", () => {
    expect(
      readInstagramAccountId({ accountId: "   " }, { parameters: { accountId: "brand" } })
    ).toBe("brand");
  });
});

function makeRuntime(settings: Record<string, string>, character?: unknown) {
  return {
    getSetting: (key: string) => settings[key],
    character,
  };
}

describe("listInstagramAccountIds", () => {
  it("returns the default id when no accounts are configured", () => {
    const runtime = makeRuntime({});
    expect(listInstagramAccountIds(runtime as never)).toEqual([DEFAULT_INSTAGRAM_ACCOUNT_ID]);
  });

  it("lists named accounts from the env JSON map without the implicit default", () => {
    const runtime = makeRuntime({
      INSTAGRAM_ACCOUNTS: JSON.stringify({
        brand: { username: "brand" },
        second: { username: "second" },
      }),
    });
    // The default id only appears when a top-level username exists; named
    // accounts stand alone so env credentials never leak onto them.
    expect(listInstagramAccountIds(runtime as never)).toEqual(["brand", "second"]);
  });

  it("includes the default id when INSTAGRAM_USERNAME is set", () => {
    const runtime = makeRuntime({ INSTAGRAM_USERNAME: "main" });
    expect(listInstagramAccountIds(runtime as never)).toEqual([DEFAULT_INSTAGRAM_ACCOUNT_ID]);
  });
});

describe("resolveDefaultInstagramAccountId", () => {
  it("prefers the explicit default account id setting", () => {
    const runtime = makeRuntime({ INSTAGRAM_DEFAULT_ACCOUNT_ID: "brand" });
    expect(resolveDefaultInstagramAccountId(runtime as never)).toBe("brand");
  });

  it("falls back to the first named account when no default is set", () => {
    const runtime = makeRuntime({
      INSTAGRAM_ACCOUNTS: JSON.stringify({
        brand: { username: "brand" },
      }),
    });
    expect(resolveDefaultInstagramAccountId(runtime as never)).toBe("brand");
  });
});

describe("resolveInstagramAccountConfig", () => {
  it("merges env credentials only for the default account", () => {
    const runtime = makeRuntime({
      INSTAGRAM_USERNAME: "main_user",
      INSTAGRAM_PASSWORD: "main_pass",
    });
    const config = resolveInstagramAccountConfig(runtime as never);
    expect(config.accountId).toBe(DEFAULT_INSTAGRAM_ACCOUNT_ID);
    expect(config.username).toBe("main_user");
    expect(config.password).toBe("main_pass");
  });

  it("does not leak default env credentials onto a named account", () => {
    const runtime = makeRuntime({
      INSTAGRAM_USERNAME: "main_user",
      INSTAGRAM_PASSWORD: "main_pass",
      INSTAGRAM_ACCOUNTS: JSON.stringify({
        brand: { username: "brand_user", password: "brand_pass" },
      }),
    });
    const config = resolveInstagramAccountConfig(runtime as never, "brand");
    expect(config.accountId).toBe("brand");
    expect(config.username).toBe("brand_user");
    expect(config.password).toBe("brand_pass");
  });

  it("reads character-level settings for the default account", () => {
    const runtime = makeRuntime(
      {},
      {
        settings: {
          instagram: {
            username: "char_user",
            password: "char_pass",
          },
        },
      }
    );
    const config = resolveInstagramAccountConfig(runtime as never);
    expect(config.username).toBe("char_user");
    expect(config.password).toBe("char_pass");
  });

  it("falls back to the default polling interval", () => {
    const runtime = makeRuntime({});
    const config = resolveInstagramAccountConfig(runtime as never);
    expect(config.pollingInterval).toBe(60);
  });

  it("honors per-account overrides over character config", () => {
    const runtime = makeRuntime(
      {
        INSTAGRAM_ACCOUNTS: JSON.stringify({
          brand: { username: "env_brand", autoRespondToDms: true },
        }),
      },
      {
        settings: {
          instagram: {
            username: "char_default",
            accounts: {
              brand: { username: "char_brand" },
            },
          },
        },
      }
    );
    const config = resolveInstagramAccountConfig(runtime as never, "brand");
    // env JSON map wins over character accounts for the same account id
    expect(config.username).toBe("env_brand");
    expect(config.autoRespondToDms).toBe(true);
  });
});
