import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWalletRoutes, type WalletRouteContext } from "./wallet-routes";

const ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "ELIZA_STEWARD_AGENT_ID",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
] as const;

function generationContext(): {
  ctx: WalletRouteContext;
  res: { statusCode?: number; body?: unknown };
  generateWalletForChain: ReturnType<typeof vi.fn>;
} {
  const res: { statusCode?: number; body?: unknown } = {};
  const generateWalletForChain = vi.fn(() => {
    throw new Error("local generation must remain unreachable");
  });
  const ctx = {
    req: { headers: {} },
    res,
    method: "POST",
    pathname: "/api/wallet/generate",
    config: {},
    saveConfig: vi.fn(),
    ensureWalletKeysInEnvAndConfig: vi.fn(),
    resolveWalletExportRejection: vi.fn(),
    deps: { generateWalletForChain },
    readJsonBody: vi.fn(async () => ({ source: "steward", chain: "evm" })),
    json(target: typeof res, data: unknown, status = 200) {
      target.statusCode = status;
      target.body = data;
    },
    error(target: typeof res, message: string, status = 400) {
      target.statusCode = status;
      target.body = { error: message };
    },
  } as unknown as WalletRouteContext;
  return { ctx, res, generateWalletForChain };
}

describe("wallet generation route Steward authority", () => {
  let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    saved = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDevCloudEnvAuthorityForTests();
  });

  it("does not query or create with inherited production credentials in default staging", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    process.env.STEWARD_API_URL = "https://eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud";
    process.env.STEWARD_AGENT_ID = "production-agent";
    process.env.STEWARD_AGENT_TOKEN = "production-token";
    captureDevCloudEnvAuthoritySnapshot();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, res, generateWalletForChain } = generationContext();

    await expect(handleWalletRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateWalletForChain).not.toHaveBeenCalled();
  });

  it("does not let late URL and token settings complete an explicit launch tuple", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.STEWARD_API_URL = "https://staging.eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud-staging";
    process.env.STEWARD_AGENT_ID = "staging-agent";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.STEWARD_API_URL = "https://eliza.app/steward";
    process.env.STEWARD_AGENT_TOKEN = "late-production-token";
    process.env.STEWARD_API_KEY = "late-production-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, res, generateWalletForChain } = generationContext();

    await expect(handleWalletRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateWalletForChain).not.toHaveBeenCalled();
  });
});
