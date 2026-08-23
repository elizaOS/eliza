/**
 * Covers wallet-capability: plugin-name matching (array / array-like /
 * iterable runtimes, identifier aliases, missing plugins), automation-mode
 * resolution, EVM plugin/service/managed-bridge detection, and
 * resolveWalletCapabilityStatus (wallet source, RPC readiness, execution
 * gates, blocked-reason precedence). Deterministic: drives the real module
 * with in-memory config/runtime fixtures and injected address/signing
 * collaborators; no live chain or model.
 */
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import type { EvmSigningCapability } from "../services/evm-signing-capability.ts";
import {
  EVM_PLUGIN_PACKAGE,
  isPluginLoadedByName,
  resolvePluginEvmLoaded,
  resolveWalletAutomationMode,
  resolveWalletCapabilityStatus,
} from "./wallet-capability.ts";

const ENV_KEYS = [
  "WALLET_SOURCE_EVM",
  "WALLET_SOURCE_SOLANA",
  "ELIZA_MANAGED_EVM_ADDRESS",
  "ELIZA_CLOUD_EVM_ADDRESS",
  "SOLANA_PRIVATE_KEY",
  "ELIZA_WALLET_NETWORK",
  "BSC_RPC_URL",
  "BSC_TESTNET_RPC_URL",
  "NODEREAL_BSC_RPC_URL",
  "QUICKNODE_BSC_RPC_URL",
  "ELIZAOS_CLOUD_API_KEY",
  "EVM_PRIVATE_KEY",
] as const;

const originalEnv = {} as {
  [K in (typeof ENV_KEYS)[number]]: string | undefined;
};
for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

const EVM_ADDR = "0x1111111111111111111111111111111111111111";
const SOL_ADDR = "So11111111111111111111111111111111111111112";
const BSC_RPC = "https://bsc.example.test/";

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearWalletEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function fakeRuntime(overrides: Record<string, unknown> = {}): AgentRuntime {
  return overrides as unknown as AgentRuntime;
}

function noneSigning(): EvmSigningCapability {
  return {
    kind: "none",
    canSign: false,
    reason: "No EVM signing path configured",
  };
}

function signing(
  kind: EvmSigningCapability["kind"],
  reason: string,
  canSign: boolean,
): EvmSigningCapability {
  return { kind, reason, canSign };
}

function resolveStatus(input: {
  config?: ElizaConfig;
  runtime?: AgentRuntime | null;
  evmAddress?: string | null;
  solanaAddress?: string | null;
  signing?: EvmSigningCapability;
}): ReturnType<typeof resolveWalletCapabilityStatus> {
  const evmAddress = input.evmAddress ?? null;
  const solanaAddress = input.solanaAddress ?? null;
  const capability = input.signing ?? noneSigning();
  return resolveWalletCapabilityStatus({
    config: input.config ?? ({} as ElizaConfig),
    runtime: input.runtime ?? null,
    getWalletAddresses: () => ({ evmAddress, solanaAddress }),
    resolveEvmSigningCapability: () => capability,
  });
}

beforeEach(() => {
  clearWalletEnv();
});

afterEach(() => {
  restoreEnv();
});

describe("EVM_PLUGIN_PACKAGE", () => {
  it("is the canonical plugin-wallet package name", () => {
    expect(EVM_PLUGIN_PACKAGE).toBe("@elizaos/plugin-wallet");
  });
});

describe("isPluginLoadedByName", () => {
  it("returns false for a null runtime and an empty plugin list", () => {
    expect(isPluginLoadedByName(null, EVM_PLUGIN_PACKAGE)).toBe(false);
    expect(
      isPluginLoadedByName(fakeRuntime({ plugins: [] }), EVM_PLUGIN_PACKAGE),
    ).toBe(false);
  });

  it("matches name, id, packageName, and npmName aliases", () => {
    expect(
      isPluginLoadedByName(
        fakeRuntime({ plugins: [{ name: EVM_PLUGIN_PACKAGE }] }),
        EVM_PLUGIN_PACKAGE,
      ),
    ).toBe(true);
    expect(
      isPluginLoadedByName(
        fakeRuntime({ plugins: [{ id: "wallet" }] }),
        EVM_PLUGIN_PACKAGE,
      ),
    ).toBe(true);
    expect(
      isPluginLoadedByName(
        fakeRuntime({ plugins: [{ packageName: "plugin-wallet" }] }),
        EVM_PLUGIN_PACKAGE,
      ),
    ).toBe(true);
    expect(
      isPluginLoadedByName(
        fakeRuntime({ plugins: [{ npmName: "vendor/plugin-wallet" }] }),
        EVM_PLUGIN_PACKAGE,
      ),
    ).toBe(true);
  });

  it("matches identifiers that include the short plugin id", () => {
    expect(
      isPluginLoadedByName(
        fakeRuntime({ plugins: [{ name: "hardware-wallet" }] }),
        EVM_PLUGIN_PACKAGE,
      ),
    ).toBe(true);
  });

  it("ignores non-object plugins and non-string identifiers", () => {
    expect(
      isPluginLoadedByName(
        fakeRuntime({ plugins: [null, "wallet", { name: 12, id: false }] }),
        EVM_PLUGIN_PACKAGE,
      ),
    ).toBe(false);
  });

  it("reads array-like plugin collections by numeric index", () => {
    const plugins = {
      0: { name: "other" },
      1: { name: "plugin-wallet" },
      length: 2,
    };
    expect(
      isPluginLoadedByName(fakeRuntime({ plugins }), EVM_PLUGIN_PACKAGE),
    ).toBe(true);
  });

  it("reads iterable plugin collections and treats a throwing iterator as empty", () => {
    expect(
      isPluginLoadedByName(
        fakeRuntime({ plugins: new Set([{ name: EVM_PLUGIN_PACKAGE }]) }),
        EVM_PLUGIN_PACKAGE,
      ),
    ).toBe(true);
    expect(
      isPluginLoadedByName(
        fakeRuntime({
          plugins: {
            [Symbol.iterator]() {
              throw new Error("iterator failed");
            },
          },
        }),
        EVM_PLUGIN_PACKAGE,
      ),
    ).toBe(false);
  });

  it("returns false when plugins is a non-collection object", () => {
    expect(
      isPluginLoadedByName(
        fakeRuntime({ plugins: { name: EVM_PLUGIN_PACKAGE } }),
        EVM_PLUGIN_PACKAGE,
      ),
    ).toBe(false);
  });
});

describe("resolveWalletAutomationMode", () => {
  it("defaults to full when features or agentAutomation are missing or invalid", () => {
    expect(resolveWalletAutomationMode({} as ElizaConfig)).toBe("full");
    expect(
      resolveWalletAutomationMode({
        features: "nope",
      } as unknown as ElizaConfig),
    ).toBe("full");
    expect(
      resolveWalletAutomationMode({
        features: { agentAutomation: ["connectors-only"] },
      } as unknown as ElizaConfig),
    ).toBe("full");
    expect(
      resolveWalletAutomationMode({
        features: { agentAutomation: { mode: "full" } },
      } as unknown as ElizaConfig),
    ).toBe("full");
  });

  it("returns connectors-only only for that exact mode", () => {
    expect(
      resolveWalletAutomationMode({
        features: { agentAutomation: { mode: "connectors-only" } },
      } as unknown as ElizaConfig),
    ).toBe("connectors-only");
    expect(
      resolveWalletAutomationMode({
        features: { agentAutomation: { mode: "CONNECTORS-ONLY" } },
      } as unknown as ElizaConfig),
    ).toBe("full");
  });
});

describe("resolvePluginEvmLoaded", () => {
  it("is true when the wallet plugin is listed on the runtime", () => {
    expect(
      resolvePluginEvmLoaded(
        fakeRuntime({ plugins: [{ name: EVM_PLUGIN_PACKAGE }] }),
      ),
    ).toBe(true);
  });

  it("is true when getService exposes evm or evmService", () => {
    expect(
      resolvePluginEvmLoaded(
        fakeRuntime({
          getService: (name: string) => (name === "evm" ? { ok: true } : null),
        }),
      ),
    ).toBe(true);
    expect(
      resolvePluginEvmLoaded(
        fakeRuntime({
          getService: (name: string) => {
            if (name === "evm") throw new Error("evm missing");
            if (name === "evmService") return { ok: true };
            return null;
          },
        }),
      ),
    ).toBe(true);
  });

  it("does not swallow a throwing getService accessor on the typeof probe", () => {
    expect(() =>
      resolvePluginEvmLoaded(
        fakeRuntime({
          get getService() {
            throw new Error("registry unavailable");
          },
        }),
      ),
    ).toThrow("registry unavailable");
  });

  it("falls back to runtime.services.get when getService is absent", () => {
    expect(
      resolvePluginEvmLoaded(
        fakeRuntime({
          services: {
            get: (name: string) => (name === "evm" ? [{ ok: true }] : []),
          },
        }),
      ),
    ).toBe(true);
    expect(
      resolvePluginEvmLoaded(
        fakeRuntime({
          services: {
            get: (name: string) => (name === "evmService" ? { ok: true } : []),
          },
        }),
      ),
    ).toBe(true);
    expect(
      resolvePluginEvmLoaded(
        fakeRuntime({
          services: {
            get: () => [],
          },
        }),
      ),
    ).toBe(false);
  });

  it("treats a throwing services.get lookup as absent and tries the next name", () => {
    expect(
      resolvePluginEvmLoaded(
        fakeRuntime({
          services: {
            get: (name: string) => {
              if (name === "evm") throw new Error("evm lookup failed");
              return { ok: true };
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("is true when a managed or cloud EVM bridge address is set", () => {
    process.env.ELIZA_MANAGED_EVM_ADDRESS = `  ${EVM_ADDR}  `;
    expect(resolvePluginEvmLoaded(null)).toBe(true);
    delete process.env.ELIZA_MANAGED_EVM_ADDRESS;
    process.env.ELIZA_CLOUD_EVM_ADDRESS = EVM_ADDR;
    expect(resolvePluginEvmLoaded(null)).toBe(true);
  });

  it("treats whitespace-only managed addresses as inactive", () => {
    process.env.ELIZA_MANAGED_EVM_ADDRESS = "   ";
    process.env.ELIZA_CLOUD_EVM_ADDRESS = "";
    expect(resolvePluginEvmLoaded(null)).toBe(false);
  });
});

describe("resolveWalletCapabilityStatus", () => {
  it("reports none / no-EVM when the queue of addresses is empty", () => {
    const status = resolveStatus({});
    expect(status.walletSource).toBe("none");
    expect(status.hasWallet).toBe(false);
    expect(status.hasEvm).toBe(false);
    expect(status.evmAddress).toBeNull();
    expect(status.solanaAddress).toBeNull();
    expect(status.pluginEvmRequired).toBe(false);
    expect(status.executionReady).toBe(false);
    expect(status.executionBlockedReason).toBe("No EVM wallet is active yet.");
    expect(status.evmSigningCapability).toBe("none");
  });

  it("blocks a Solana-only wallet as missing EVM and does not require the EVM plugin", () => {
    const status = resolveStatus({ solanaAddress: SOL_ADDR });
    expect(status.hasWallet).toBe(true);
    expect(status.hasEvm).toBe(false);
    expect(status.pluginEvmRequired).toBe(false);
    expect(status.walletSource).toBe("managed");
    expect(status.executionBlockedReason).toBe("No EVM wallet is active yet.");
    expect(status.executionReady).toBe(false);
  });

  it("blocks an EVM wallet when BSC RPC is not configured", () => {
    const status = resolveStatus({ evmAddress: EVM_ADDR });
    expect(status.rpcReady).toBe(false);
    expect(status.pluginEvmRequired).toBe(true);
    expect(status.executionBlockedReason).toBe("BSC RPC is not configured.");
    expect(status.executionReady).toBe(false);
  });

  it("blocks when RPC is ready but plugin-wallet is not loaded", () => {
    process.env.BSC_RPC_URL = BSC_RPC;
    const status = resolveStatus({ evmAddress: EVM_ADDR });
    expect(status.rpcReady).toBe(true);
    expect(status.pluginEvmLoaded).toBe(false);
    expect(status.executionBlockedReason).toBe(
      "@elizaos/plugin-wallet is not loaded, so EVM wallet execution is unavailable.",
    );
    expect(status.executionReady).toBe(false);
  });

  it("blocks when automation is connectors-only even if the other gates pass", () => {
    process.env.BSC_RPC_URL = BSC_RPC;
    process.env.ELIZA_MANAGED_EVM_ADDRESS = EVM_ADDR;
    const status = resolveStatus({
      evmAddress: EVM_ADDR,
      config: {
        features: { agentAutomation: { mode: "connectors-only" } },
      } as unknown as ElizaConfig,
    });
    expect(status.automationMode).toBe("connectors-only");
    expect(status.pluginEvmLoaded).toBe(true);
    expect(status.rpcReady).toBe(true);
    expect(status.executionReady).toBe(false);
    expect(status.executionBlockedReason).toBe(
      "Agent automation is in connectors-only mode, so wallet execution is blocked in chat.",
    );
  });

  it("is execution-ready when EVM, RPC, plugin, and full automation all hold", () => {
    process.env.BSC_RPC_URL = BSC_RPC;
    const status = resolveStatus({
      evmAddress: EVM_ADDR,
      solanaAddress: SOL_ADDR,
      runtime: fakeRuntime({ plugins: [{ name: EVM_PLUGIN_PACKAGE }] }),
      config: { wallet: { network: "testnet" } } as unknown as ElizaConfig,
    });
    expect(status.walletNetwork).toBe("testnet");
    expect(status.evmAddress).toBe(EVM_ADDR);
    expect(status.solanaAddress).toBe(SOL_ADDR);
    expect(status.hasWallet).toBe(true);
    expect(status.hasEvm).toBe(true);
    expect(status.rpcReady).toBe(true);
    expect(status.pluginEvmLoaded).toBe(true);
    expect(status.automationMode).toBe("full");
    expect(status.executionReady).toBe(true);
    expect(status.executionBlockedReason).toBeNull();
  });

  it("prefers the cloud-view-only signing reason over later execution gates", () => {
    const reason =
      "Cloud wallet provisioned (view-only — local signing unavailable)";
    const status = resolveStatus({
      evmAddress: EVM_ADDR,
      signing: signing("cloud-view-only", reason, false),
    });
    expect(status.rpcReady).toBe(false);
    expect(status.executionBlockedReason).toBe(reason);
    expect(status.evmSigningCapability).toBe("cloud-view-only");
    expect(status.evmSigningReason).toBe(reason);
    expect(status.executionReady).toBe(false);
  });

  it("keeps executionReady independent of cloud-view-only once the other gates pass", () => {
    process.env.BSC_RPC_URL = BSC_RPC;
    process.env.ELIZA_MANAGED_EVM_ADDRESS = EVM_ADDR;
    const reason =
      "Cloud wallet provisioned (view-only — local signing unavailable)";
    const status = resolveStatus({
      evmAddress: EVM_ADDR,
      signing: signing("cloud-view-only", reason, false),
    });
    expect(status.executionReady).toBe(true);
    expect(status.executionBlockedReason).toBe(reason);
  });

  it("marks walletSource managed when a cloud primary is configured, even with no address", () => {
    const status = resolveStatus({
      config: {
        wallet: { primary: { evm: "cloud", solana: "local" } },
      } as unknown as ElizaConfig,
    });
    expect(status.walletSource).toBe("managed");
  });

  it("reads primary source from env when config.wallet is missing or invalid", () => {
    process.env.WALLET_SOURCE_EVM = "cloud";
    expect(
      resolveStatus({
        config: { wallet: "nope" } as unknown as ElizaConfig,
      }).walletSource,
    ).toBe("managed");

    process.env.WALLET_SOURCE_EVM = "local";
    expect(resolveStatus({ evmAddress: EVM_ADDR }).walletSource).toBe("local");
  });

  it("marks walletSource local for a local signer even without a derived address", () => {
    const status = resolveStatus({
      signing: signing("local", "env: EVM_PRIVATE_KEY", true),
    });
    expect(status.walletSource).toBe("local");
    expect(status.localSignerAvailable).toBe(true);
    expect(status.pluginEvmRequired).toBe(true);
    expect(status.executionBlockedReason).toBe("No EVM wallet is active yet.");
  });

  it("marks walletSource local from a Solana private key and none when local primary has no wallet", () => {
    process.env.SOLANA_PRIVATE_KEY = "  sol-secret  ";
    expect(resolveStatus({}).walletSource).toBe("local");

    delete process.env.SOLANA_PRIVATE_KEY;
    expect(
      resolveStatus({
        config: {
          wallet: { primary: { evm: "local" } },
        } as unknown as ElizaConfig,
      }).walletSource,
    ).toBe("none");
  });

  it("ignores whitespace-only Solana keys and unknown primary / env source values", () => {
    process.env.SOLANA_PRIVATE_KEY = "   ";
    process.env.WALLET_SOURCE_EVM = "hardware";
    const status = resolveStatus({
      config: {
        wallet: { primary: { evm: "hardware", solana: 1 } },
      } as unknown as ElizaConfig,
    });
    expect(status.walletSource).toBe("none");
  });

  it("uses the real default signing resolver when EVM_PRIVATE_KEY is set", () => {
    process.env.EVM_PRIVATE_KEY = "0xabc";
    const status = resolveWalletCapabilityStatus({
      config: {} as ElizaConfig,
      runtime: null,
      getWalletAddresses: () => ({ evmAddress: null, solanaAddress: null }),
    });
    expect(status.localSignerAvailable).toBe(true);
    expect(status.evmSigningCapability).toBe("local");
    expect(status.evmSigningReason).toBe("env: EVM_PRIVATE_KEY");
    expect(status.walletSource).toBe("local");
  });
});
