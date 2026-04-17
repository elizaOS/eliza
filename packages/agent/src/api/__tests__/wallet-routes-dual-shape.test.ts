/**
 * Phase 6: dual-wallet response shape + POST /primary + POST /refresh-cloud.
 *
 * These are narrow contract tests around `handleWalletRoutes`. They invoke
 * the handler with a stubbed HTTP ctx and stubbed deps rather than spinning
 * up a real runtime, so they stay fast and deterministic.
 */

import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../cloud/bridge-client.js", () => ({
  ElizaCloudClient: class ElizaCloudClientMock {},
}));

vi.mock("../../cloud/cloud-wallet.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../cloud/cloud-wallet.js")
  >("../../cloud/cloud-wallet.js");
  return {
    ...actual,
    getOrCreateClientAddressKey: vi.fn(),
    provisionCloudWalletsBestEffort: vi.fn(),
  };
});

import {
  getOrCreateClientAddressKey,
  provisionCloudWalletsBestEffort,
} from "../../cloud/cloud-wallet.js";
import type { ElizaConfig } from "../../config/config.js";
import {
  DEFAULT_WALLET_ROUTE_DEPENDENCIES,
  handleWalletRoutes,
  type WalletRouteContext,
  type WalletRouteDependencies,
} from "../wallet-routes.js";

function makeCtx(
  overrides: Partial<WalletRouteContext> & {
    pathname: string;
    method: string;
    body?: unknown;
    config?: ElizaConfig;
    depsOverrides?: Partial<WalletRouteDependencies>;
  },
): {
  ctx: WalletRouteContext;
  sent: { status: number; body: unknown };
  restarts: string[];
  immediateRestarts: string[];
  savedConfigs: ElizaConfig[];
} {
  const sent = { status: 0, body: undefined as unknown };
  const restarts: string[] = [];
  const immediateRestarts: string[] = [];
  const savedConfigs: ElizaConfig[] = [];
  const config = overrides.config ?? ({} as ElizaConfig);

  const ctx: WalletRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: overrides.method,
    pathname: overrides.pathname,
    config,
    saveConfig: (c) => {
      savedConfigs.push(JSON.parse(JSON.stringify(c)) as ElizaConfig);
    },
    ensureWalletKeysInEnvAndConfig: () => false,
    resolveWalletExportRejection: () => null,
    restartRuntime: overrides.restartRuntime
      ? async (reason: string) => {
          immediateRestarts.push(reason);
          return await overrides.restartRuntime?.(reason);
        }
      : undefined,
    scheduleRuntimeRestart: (reason: string) => {
      restarts.push(reason);
    },
    json: (_res, data, status = 200) => {
      sent.status = status;
      sent.body = data;
    },
    error: (_res, message, status = 400) => {
      sent.status = status;
      sent.body = { error: message };
    },
    readJsonBody: async () => (overrides.body ?? null) as never,
    deps: {
      ...DEFAULT_WALLET_ROUTE_DEPENDENCIES,
      getWalletAddresses: () => ({
        evmAddress: "0xLOCAL_EVM",
        solanaAddress: "LOCAL_SOL",
      }),
      ...(overrides.depsOverrides ?? {}),
    },
    runtime: overrides.runtime ?? null,
  };

  return { ctx, sent, restarts, immediateRestarts, savedConfigs };
}

const ORIGINAL_ENV = { ...process.env };
let tmpStateDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wallet-routes-"));
  process.env.MILADY_STATE_DIR = tmpStateDir;
  delete process.env.ENABLE_CLOUD_WALLET;
  delete process.env.ELIZAOS_CLOUD_API_KEY;
  delete process.env.WALLET_SOURCE_EVM;
  delete process.env.WALLET_SOURCE_SOLANA;
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await fs.rm(tmpStateDir, { recursive: true, force: true }).catch(() => {});
  vi.restoreAllMocks();
});

describe("GET /api/wallet/config — dual-wallet shape", () => {
  it("omits wallets[]/primary when ENABLE_CLOUD_WALLET is off (flag-off backwards compat)", async () => {
    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/config",
      method: "GET",
    });
    const handled = await handleWalletRoutes(ctx);
    expect(handled).toBe(true);
    const body = sent.body as Record<string, unknown>;
    expect(body.wallets).toBeUndefined();
    expect(body.primary).toBeUndefined();
    // Pre-existing fields still present.
    expect(body.evmAddress).toBe("0xLOCAL_EVM");
    expect(body.solanaAddress).toBe("LOCAL_SOL");
  });

  it("includes wallets[] (local only) and primary.local defaults when flag on + no cloud cache", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/config",
      method: "GET",
    });
    await handleWalletRoutes(ctx);
    const body = sent.body as {
      wallets: Array<Record<string, unknown>>;
      primary: { evm: string; solana: string };
    };
    expect(body.wallets).toHaveLength(2);
    expect(body.wallets.every((w) => w.source === "local")).toBe(true);
    expect(body.primary).toEqual({ evm: "local", solana: "local" });
    expect(body.wallets.find((w) => w.chain === "evm")?.primary).toBe(true);
  });

  it("includes cloud entries from cached wallet.cloud.* when flag on", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const config = {
      wallet: {
        cloud: {
          evm: {
            walletAddress: "0xCLOUD_EVM",
            walletProvider: "privy",
          },
          solana: {
            walletAddress: "CLOUD_SOL",
            walletProvider: "steward",
          },
        },
        primary: { evm: "cloud", solana: "local" },
      },
    } as unknown as ElizaConfig;

    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/config",
      method: "GET",
      config,
    });
    await handleWalletRoutes(ctx);
    const body = sent.body as {
      evmAddress: string | null;
      solanaAddress: string | null;
      wallets: Array<{
        source: string;
        chain: string;
        address: string;
        provider: string;
        primary: boolean;
      }>;
      primary: { evm: string; solana: string };
    };

    expect(body.wallets).toHaveLength(4);
    expect(body.primary).toEqual({ evm: "cloud", solana: "local" });
    expect(body.evmAddress).toBe("0xCLOUD_EVM");
    expect(body.solanaAddress).toBe("LOCAL_SOL");

    const cloudEvm = body.wallets.find(
      (w) => w.source === "cloud" && w.chain === "evm",
    );
    expect(cloudEvm).toMatchObject({
      address: "0xCLOUD_EVM",
      provider: "privy",
      primary: true,
    });
    const localEvm = body.wallets.find(
      (w) => w.source === "local" && w.chain === "evm",
    );
    expect(localEvm?.primary).toBe(false);
  });

  it("marks cloud-primary solana wallets as signable in the top-level config", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const config = {
      wallet: {
        cloud: {
          solana: {
            walletAddress: "CLOUD_SOL",
            walletProvider: "steward",
          },
        },
        primary: { evm: "local", solana: "cloud" },
      },
    } as unknown as ElizaConfig;

    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/config",
      method: "GET",
      config,
    });
    await handleWalletRoutes(ctx);
    const body = sent.body as {
      solanaAddress: string | null;
      solanaSigningAvailable: boolean;
    };

    expect(body.solanaAddress).toBe("CLOUD_SOL");
    expect(body.solanaSigningAvailable).toBe(true);
  });

  it("skips cloud entry when walletAddress is empty/missing", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const config = {
      wallet: { cloud: { evm: { walletAddress: "" } } },
    } as unknown as ElizaConfig;
    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/config",
      method: "GET",
      config,
    });
    await handleWalletRoutes(ctx);
    const body = sent.body as { wallets: Array<{ source: string }> };
    expect(body.wallets.every((w) => w.source === "local")).toBe(true);
  });
});

describe("POST /api/wallet/primary", () => {
  it("returns 404 when ENABLE_CLOUD_WALLET is off", async () => {
    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/primary",
      method: "POST",
      body: { chain: "evm", source: "cloud" },
    });
    await handleWalletRoutes(ctx);
    expect(sent.status).toBe(404);
  });

  it("persists primary selection + writes config.env + restarts immediately when available", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const { ctx, sent, restarts, immediateRestarts, savedConfigs } = makeCtx({
      pathname: "/api/wallet/primary",
      method: "POST",
      body: { chain: "evm", source: "cloud" },
      restartRuntime: vi.fn(async () => true),
    });
    await handleWalletRoutes(ctx);

    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      ok: true,
      chain: "evm",
      source: "cloud",
    });

    const lastSaved = savedConfigs.at(-1) as unknown as {
      wallet: { primary: { evm: string } };
    };
    expect(lastSaved.wallet.primary.evm).toBe("cloud");

    expect(process.env.WALLET_SOURCE_EVM).toBe("cloud");
    const configEnv = await fs.readFile(
      path.join(tmpStateDir, "config.env"),
      "utf8",
    );
    expect(configEnv).toContain("WALLET_SOURCE_EVM=cloud");

    expect(immediateRestarts).toEqual(["primary-changed"]);
    expect(restarts).toEqual([]);
  });

  it("writes WALLET_SOURCE_SOLANA when chain === 'solana'", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const { ctx } = makeCtx({
      pathname: "/api/wallet/primary",
      method: "POST",
      body: { chain: "solana", source: "local" },
    });
    await handleWalletRoutes(ctx);
    expect(process.env.WALLET_SOURCE_SOLANA).toBe("local");
    const configEnv = await fs.readFile(
      path.join(tmpStateDir, "config.env"),
      "utf8",
    );
    expect(configEnv).toContain("WALLET_SOURCE_SOLANA=local");
  });

  it("validates chain enum", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/primary",
      method: "POST",
      body: { chain: "bitcoin", source: "cloud" },
    });
    await handleWalletRoutes(ctx);
    expect(sent.status).toBe(400);
    expect((sent.body as { error: string }).error).toMatch(/chain/);
  });

  it("validates source enum", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/primary",
      method: "POST",
      body: { chain: "evm", source: "sky" },
    });
    await handleWalletRoutes(ctx);
    expect(sent.status).toBe(400);
    expect((sent.body as { error: string }).error).toMatch(/source/);
  });
});

describe("POST /api/wallet/refresh-cloud", () => {
  it("returns 404 when flag off", async () => {
    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/refresh-cloud",
      method: "POST",
    });
    await handleWalletRoutes(ctx);
    expect(sent.status).toBe(404);
  });

  it("returns 400 when flag on but cloud is not linked (no apiKey)", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/refresh-cloud",
      method: "POST",
    });
    await handleWalletRoutes(ctx);
    expect(sent.status).toBe(400);
    expect((sent.body as { error: string }).error).toMatch(/not linked/i);
  });

  it("returns 400 when flag on + cloud linked but no agent configured", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    const config = {
      cloud: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
    } as unknown as ElizaConfig;
    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/refresh-cloud",
      method: "POST",
      config,
    });
    await handleWalletRoutes(ctx);
    expect(sent.status).toBe(400);
    expect((sent.body as { error: string }).error).toMatch(/agent/i);
  });

  it("uses the runtime saved cloud key and persists imported cloud wallets as primary", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    vi.mocked(getOrCreateClientAddressKey).mockResolvedValue({
      privateKey: `0x${"33".repeat(32)}`,
      address: "0x1234567890abcdef1234567890abcdef12345678",
      minted: false,
    });
    vi.mocked(provisionCloudWalletsBestEffort).mockResolvedValue({
      descriptors: {
        evm: {
          agentWalletId: "wallet-evm",
          walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          walletProvider: "privy",
          chainType: "evm",
        },
        solana: {
          agentWalletId: "wallet-sol",
          walletAddress: "So11111111111111111111111111111111111111112",
          walletProvider: "steward",
          chainType: "solana",
        },
      },
      failures: [],
      warnings: [],
    });

    const config = {
      cloud: { baseUrl: "https://www.elizacloud.ai" },
    } as unknown as ElizaConfig;
    const { ctx, sent, restarts, immediateRestarts, savedConfigs } = makeCtx({
      pathname: "/api/wallet/refresh-cloud",
      method: "POST",
      config,
      runtime: {
        agentId: "agent-123",
        getSetting: (key: string) =>
          key === "ELIZAOS_CLOUD_API_KEY" ? "runtime-saved-key" : undefined,
      } as never,
      restartRuntime: vi.fn(async () => true),
    });

    await handleWalletRoutes(ctx);

    expect(sent.status).toBe(200);
    expect(immediateRestarts).toEqual(["cloud-refreshed"]);
    expect(restarts).toEqual([]);

    const configEnv = await fs.readFile(
      path.join(tmpStateDir, "config.env"),
      "utf8",
    );
    expect(configEnv).toContain("ENABLE_CLOUD_WALLET=1");
    expect(configEnv).toContain(
      "MILADY_CLOUD_EVM_ADDRESS=0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    expect(configEnv).toContain(
      "MILADY_CLOUD_SOLANA_ADDRESS=So11111111111111111111111111111111111111112",
    );
    expect(configEnv).toContain("WALLET_SOURCE_EVM=cloud");
    expect(configEnv).toContain("WALLET_SOURCE_SOLANA=cloud");

    const lastSaved = savedConfigs.at(-1) as {
      wallet?: {
        primary?: { evm?: string; solana?: string };
        cloud?: {
          evm?: { walletAddress?: string };
          solana?: { walletAddress?: string };
        };
      };
      cloud?: { clientAddressPublicKey?: string };
    };

    expect(lastSaved.cloud?.clientAddressPublicKey).toBe(
      "0x1234567890abcdef1234567890abcdef12345678",
    );
    expect(lastSaved.wallet?.primary).toEqual({
      evm: "cloud",
      solana: "cloud",
    });
    expect(lastSaved.wallet?.cloud?.evm?.walletAddress).toBe(
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
  });

  it("returns partial success warnings without discarding imported EVM wallets", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    vi.mocked(getOrCreateClientAddressKey).mockResolvedValue({
      privateKey: `0x${"44".repeat(32)}`,
      address: "0x1234567890abcdef1234567890abcdef12345678",
      minted: false,
    });
    vi.mocked(provisionCloudWalletsBestEffort).mockResolvedValue({
      descriptors: {
        evm: {
          agentWalletId: "wallet-evm",
          walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          walletProvider: "privy",
          chainType: "evm",
        },
      },
      failures: [
        {
          chain: "solana",
          error: new Error("Validation error: Invalid Solana address"),
        },
      ],
      warnings: [
        "Cloud solana wallet import failed: Validation error: Invalid Solana address",
      ],
    });

    const config = {
      cloud: { baseUrl: "https://www.elizacloud.ai" },
    } as unknown as ElizaConfig;
    const { ctx, sent, savedConfigs } = makeCtx({
      pathname: "/api/wallet/refresh-cloud",
      method: "POST",
      config,
      runtime: {
        agentId: "agent-123",
        getSetting: (key: string) =>
          key === "ELIZAOS_CLOUD_API_KEY" ? "runtime-saved-key" : undefined,
      } as never,
    });

    await handleWalletRoutes(ctx);

    expect(sent.status).toBe(200);
    expect((sent.body as { warnings?: string[] }).warnings).toEqual([
      "Cloud solana wallet import failed: Validation error: Invalid Solana address",
    ]);

    const configEnv = await fs.readFile(
      path.join(tmpStateDir, "config.env"),
      "utf8",
    );
    expect(configEnv).toContain(
      "MILADY_CLOUD_EVM_ADDRESS=0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    expect(configEnv).not.toContain("MILADY_CLOUD_SOLANA_ADDRESS=");
    expect(configEnv).toContain("WALLET_SOURCE_EVM=cloud");
    expect(configEnv).not.toContain("WALLET_SOURCE_SOLANA=cloud");

    const lastSaved = savedConfigs.at(-1) as {
      wallet?: {
        primary?: { evm?: string; solana?: string };
        cloud?: {
          evm?: { walletAddress?: string };
          solana?: { walletAddress?: string };
        };
      };
    };

    expect(lastSaved.wallet?.primary).toEqual({
      evm: "cloud",
    });
    expect(lastSaved.wallet?.cloud?.evm?.walletAddress).toBe(
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    expect(lastSaved.wallet?.cloud?.solana?.walletAddress).toBeUndefined();
  });

  it("keeps Solana on cloud when the backend returns the legacy provision error", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    vi.mocked(getOrCreateClientAddressKey).mockResolvedValue({
      privateKey: `0x${"46".repeat(32)}`,
      address: "0x1234567890abcdef1234567890abcdef12345678",
      minted: false,
    });
    vi.mocked(provisionCloudWalletsBestEffort).mockResolvedValue({
      descriptors: {
        evm: {
          agentWalletId: "wallet-evm",
          walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          walletProvider: "privy",
          chainType: "evm",
        },
      },
      failures: [
        {
          chain: "solana",
          error: new Error(
            "Validation error: Invalid Solana address (base58, 32–44 chars)",
          ),
        },
      ],
      warnings: [
        "Cloud solana wallet import failed: Validation error: Invalid Solana address (base58, 32–44 chars)",
      ],
    });

    const config = {
      cloud: { baseUrl: "https://www.elizacloud.ai" },
    } as unknown as ElizaConfig;
    const { ctx, sent, savedConfigs } = makeCtx({
      pathname: "/api/wallet/refresh-cloud",
      method: "POST",
      config,
      runtime: {
        agentId: "agent-123",
        getSetting: (key: string) =>
          key === "ELIZAOS_CLOUD_API_KEY" ? "runtime-saved-key" : undefined,
      } as never,
    });

    await handleWalletRoutes(ctx);

    expect(sent.status).toBe(200);
    expect((sent.body as { warnings?: string[] }).warnings).toEqual([
      "Cloud solana wallet import failed: Validation error: Invalid Solana address (base58, 32–44 chars)",
    ]);

    const configEnv = await fs.readFile(
      path.join(tmpStateDir, "config.env"),
      "utf8",
    );
    expect(configEnv).not.toContain("SOLANA_PRIVATE_KEY=");
    expect(configEnv).not.toContain("WALLET_SOURCE_SOLANA=local");

    const lastSaved = savedConfigs.at(-1) as {
      wallet?: {
        primary?: { evm?: string; solana?: string };
        cloud?: {
          evm?: { walletAddress?: string };
          solana?: { walletAddress?: string };
        };
      };
    };

    expect(lastSaved.wallet?.primary).toEqual({
      evm: "cloud",
    });
    expect(lastSaved.wallet?.cloud?.evm?.walletAddress).toBe(
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    expect(lastSaved.wallet?.cloud?.solana?.walletAddress).toBeUndefined();
  });

  it("only provisions missing cloud chains when one chain is already cached", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    vi.mocked(getOrCreateClientAddressKey).mockResolvedValue({
      privateKey: `0x${"55".repeat(32)}`,
      address: "0x1234567890abcdef1234567890abcdef12345678",
      minted: false,
    });
    vi.mocked(provisionCloudWalletsBestEffort).mockResolvedValue({
      descriptors: {
        solana: {
          agentWalletId: "wallet-sol",
          walletAddress: "So11111111111111111111111111111111111111112",
          walletProvider: "steward",
          chainType: "solana",
        },
      },
      failures: [],
      warnings: [],
    });

    const config = {
      cloud: { baseUrl: "https://www.elizacloud.ai" },
      wallet: {
        cloud: {
          evm: {
            agentWalletId: "wallet-evm",
            walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            walletProvider: "privy",
          },
        },
      },
    } as unknown as ElizaConfig;
    const { ctx, sent, savedConfigs } = makeCtx({
      pathname: "/api/wallet/refresh-cloud",
      method: "POST",
      config,
      runtime: {
        agentId: "agent-123",
        getSetting: (key: string) =>
          key === "ELIZAOS_CLOUD_API_KEY" ? "runtime-saved-key" : undefined,
      } as never,
    });

    await handleWalletRoutes(ctx);

    expect(sent.status).toBe(200);
    expect(provisionCloudWalletsBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: "agent-123",
        clientAddress: "0x1234567890abcdef1234567890abcdef12345678",
        chains: ["solana"],
      }),
    );
    expect((sent.body as { warnings?: string[] }).warnings).toBeUndefined();

    const lastSaved = savedConfigs.at(-1) as {
      wallet?: {
        primary?: { evm?: string; solana?: string };
        cloud?: {
          evm?: { walletAddress?: string };
          solana?: { walletAddress?: string };
        };
      };
    };

    expect(lastSaved.wallet?.primary).toEqual({
      evm: "cloud",
      solana: "cloud",
    });
    expect(lastSaved.wallet?.cloud?.evm?.walletAddress).toBe(
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    expect(lastSaved.wallet?.cloud?.solana?.walletAddress).toBe(
      "So11111111111111111111111111111111111111112",
    );
  });

  it("returns cached cloud wallets without reprovisioning when both chains already exist", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    vi.mocked(getOrCreateClientAddressKey).mockResolvedValue({
      privateKey: `0x${"56".repeat(32)}`,
      address: "0x1234567890abcdef1234567890abcdef12345678",
      minted: false,
    });

    const config = {
      cloud: { baseUrl: "https://www.elizacloud.ai" },
      wallet: {
        cloud: {
          evm: {
            agentWalletId: "wallet-evm",
            walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            walletProvider: "privy",
          },
          solana: {
            agentWalletId: "wallet-sol",
            walletAddress: "So11111111111111111111111111111111111111112",
            walletProvider: "steward",
          },
        },
      },
    } as unknown as ElizaConfig;
    const { ctx, sent } = makeCtx({
      pathname: "/api/wallet/refresh-cloud",
      method: "POST",
      config,
      runtime: {
        agentId: "agent-123",
        getSetting: (key: string) =>
          key === "ELIZAOS_CLOUD_API_KEY" ? "runtime-saved-key" : undefined,
      } as never,
    });

    await handleWalletRoutes(ctx);

    expect(sent.status).toBe(200);
    expect(provisionCloudWalletsBestEffort).not.toHaveBeenCalled();
    expect((sent.body as { warnings?: string[] }).warnings).toBeUndefined();
  });
});

describe("PUT /api/wallet/config", () => {
  it("enables the cloud wallet feature flag when all rpc providers use Eliza Cloud", async () => {
    const { ctx, sent, restarts, immediateRestarts } = makeCtx({
      pathname: "/api/wallet/config",
      method: "PUT",
      body: {
        selections: {
          evm: "eliza-cloud",
          bsc: "eliza-cloud",
          solana: "eliza-cloud",
        },
        walletNetwork: "mainnet",
      },
    });

    await handleWalletRoutes(ctx);

    expect(sent.status).toBe(200);
    expect(process.env.ENABLE_CLOUD_WALLET).toBe("1");
    expect(immediateRestarts).toEqual([]);
    expect(restarts).toEqual([]);
    const configEnv = await fs.readFile(
      path.join(tmpStateDir, "config.env"),
      "utf8",
    );
    expect(configEnv).toContain("ENABLE_CLOUD_WALLET=1");
  });
});
