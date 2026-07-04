/**
 * Deterministic unit coverage for the plugin-diagnostic card builders:
 * `buildPluginDiagnosticEntry` (descriptor + status → UI card, with defensive
 * array copies) and `resolveWalletDiagnosticStatus` (wallet capability →
 * loaded / auto-enabled / blocked / missing-prerequisites / disabled), driven
 * with `resolveWalletCapabilityStatus` mocked so wallet state is fixture-set.
 */
import type { PluginDiagnosticDescriptor } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config";
import type { WalletCapabilityStatus } from "./wallet-capability";

const resolveWalletCapabilityStatusMock =
  vi.fn<(state: unknown) => WalletCapabilityStatus>();

vi.mock("./wallet-capability", () => ({
  resolveWalletCapabilityStatus: (state: unknown) =>
    resolveWalletCapabilityStatusMock(state),
}));

import {
  buildPluginDiagnosticEntry,
  resolveWalletDiagnosticStatus,
} from "./plugin-diagnostic";

const WALLET_DESCRIPTOR: PluginDiagnosticDescriptor = {
  id: "evm",
  name: "Plugin EVM",
  description:
    "EVM wallet runtime for balance, transfer, and trade actions. Required for wallet execution in chat.",
  tags: ["wallet", "evm", "bsc", "onchain"],
  envKey: "EVM_PRIVATE_KEY",
  category: "feature",
  source: "bundled",
  configKeys: [
    "EVM_PRIVATE_KEY",
    "BSC_RPC_URL",
    "BSC_TESTNET_RPC_URL",
    "ELIZA_WALLET_NETWORK",
  ],
  npmName: "@elizaos/plugin-wallet",
  managementMode: "core-optional",
  aliases: ["evm", "wallet"],
  prerequisites: [
    { key: "wallet", label: "wallet present" },
    { key: "rpc", label: "rpc ready" },
    { key: "plugin", label: "plugin loaded" },
  ],
};

function makeCapability(
  overrides: Partial<WalletCapabilityStatus>,
): WalletCapabilityStatus {
  return {
    walletSource: "none",
    walletNetwork: "mainnet",
    evmAddress: null,
    solanaAddress: null,
    hasWallet: false,
    hasEvm: false,
    localSignerAvailable: false,
    rpcReady: false,
    automationMode: "full",
    pluginEvmLoaded: false,
    pluginEvmRequired: false,
    executionReady: false,
    executionBlockedReason: null,
    evmSigningCapability: "none",
    evmSigningReason: "",
    ...overrides,
  };
}

function makeState(allow: string[]): {
  config: ElizaConfig;
  runtime: null;
} {
  return {
    config: { plugins: { allow } } as ElizaConfig,
    runtime: null,
  };
}

describe("buildPluginDiagnosticEntry", () => {
  it("renders a descriptor + status into the plugin card generically", () => {
    const entry = buildPluginDiagnosticEntry(WALLET_DESCRIPTOR, {
      enabled: true,
      configured: true,
      isActive: false,
      autoEnabled: true,
      capabilityStatus: "auto-enabled",
      capabilityReason: "because",
      prerequisiteMet: { wallet: true, rpc: false, plugin: false },
    });

    expect(entry).toEqual({
      id: "evm",
      name: "Plugin EVM",
      description:
        "EVM wallet runtime for balance, transfer, and trade actions. Required for wallet execution in chat.",
      tags: ["wallet", "evm", "bsc", "onchain"],
      enabled: true,
      configured: true,
      envKey: "EVM_PRIVATE_KEY",
      category: "feature",
      source: "bundled",
      configKeys: [
        "EVM_PRIVATE_KEY",
        "BSC_RPC_URL",
        "BSC_TESTNET_RPC_URL",
        "ELIZA_WALLET_NETWORK",
      ],
      parameters: [],
      validationErrors: [],
      validationWarnings: [],
      npmName: "@elizaos/plugin-wallet",
      isActive: false,
      autoEnabled: true,
      managementMode: "core-optional",
      capabilityStatus: "auto-enabled",
      capabilityReason: "because",
      prerequisites: [
        { label: "wallet present", met: true },
        { label: "rpc ready", met: false },
        { label: "plugin loaded", met: false },
      ],
    });
  });

  it("copies descriptor arrays instead of aliasing them", () => {
    const entry = buildPluginDiagnosticEntry(WALLET_DESCRIPTOR, {
      enabled: false,
      configured: false,
      isActive: false,
      autoEnabled: false,
      capabilityStatus: "disabled",
      capabilityReason: null,
      prerequisiteMet: {},
    });
    expect(entry.tags).not.toBe(WALLET_DESCRIPTOR.tags);
    expect(entry.configKeys).not.toBe(WALLET_DESCRIPTOR.configKeys);
    expect(entry.prerequisites).toEqual([
      { label: "wallet present", met: false },
      { label: "rpc ready", met: false },
      { label: "plugin loaded", met: false },
    ]);
  });
});

describe("resolveWalletDiagnosticStatus", () => {
  it("preserves the exact loaded card output", () => {
    resolveWalletCapabilityStatusMock.mockReturnValue(
      makeCapability({
        evmAddress: "0xabc",
        hasEvm: true,
        hasWallet: true,
        rpcReady: true,
        pluginEvmLoaded: true,
        pluginEvmRequired: true,
        executionReady: true,
      }),
    );

    const state = makeState([]);
    const entry = buildPluginDiagnosticEntry(
      WALLET_DESCRIPTOR,
      resolveWalletDiagnosticStatus(WALLET_DESCRIPTOR, state),
    );

    expect(entry).toEqual({
      id: "evm",
      name: "Plugin EVM",
      description:
        "EVM wallet runtime for balance, transfer, and trade actions. Required for wallet execution in chat.",
      tags: ["wallet", "evm", "bsc", "onchain"],
      enabled: true,
      configured: true,
      envKey: "EVM_PRIVATE_KEY",
      category: "feature",
      source: "bundled",
      configKeys: [
        "EVM_PRIVATE_KEY",
        "BSC_RPC_URL",
        "BSC_TESTNET_RPC_URL",
        "ELIZA_WALLET_NETWORK",
      ],
      parameters: [],
      validationErrors: [],
      validationWarnings: [],
      npmName: "@elizaos/plugin-wallet",
      isActive: true,
      autoEnabled: false,
      managementMode: "core-optional",
      capabilityStatus: "loaded",
      capabilityReason: "Wallet execution is ready.",
      prerequisites: [
        { label: "wallet present", met: true },
        { label: "rpc ready", met: true },
        { label: "plugin loaded", met: true },
      ],
    });
  });

  it("maps auto-enabled when loaded but not required", () => {
    resolveWalletCapabilityStatusMock.mockReturnValue(
      makeCapability({ pluginEvmLoaded: true, pluginEvmRequired: false }),
    );
    const status = resolveWalletDiagnosticStatus(
      WALLET_DESCRIPTOR,
      makeState([]),
    );
    expect(status.capabilityStatus).toBe("auto-enabled");
    expect(status.enabled).toBe(true);
    expect(status.autoEnabled).toBe(false);
    expect(status.isActive).toBe(true);
  });

  it("blocks when a wallet is present but the plugin is not loaded", () => {
    resolveWalletCapabilityStatusMock.mockReturnValue(
      makeCapability({
        evmAddress: "0xabc",
        hasEvm: true,
        pluginEvmRequired: true,
        executionBlockedReason: "BSC RPC is not configured.",
      }),
    );
    const status = resolveWalletDiagnosticStatus(
      WALLET_DESCRIPTOR,
      makeState([]),
    );
    expect(status.capabilityStatus).toBe("blocked");
    expect(status.capabilityReason).toBe("BSC RPC is not configured.");
    expect(status.prerequisiteMet).toEqual({
      wallet: true,
      rpc: false,
      plugin: false,
    });
  });

  it("reports missing-prerequisites when enabled via allowlist alias only", () => {
    resolveWalletCapabilityStatusMock.mockReturnValue(makeCapability({}));
    const status = resolveWalletDiagnosticStatus(
      WALLET_DESCRIPTOR,
      makeState(["wallet"]),
    );
    expect(status.enabled).toBe(true);
    expect(status.capabilityStatus).toBe("missing-prerequisites");
  });

  it("enables via the npm package alias in the allowlist", () => {
    resolveWalletCapabilityStatusMock.mockReturnValue(makeCapability({}));
    const status = resolveWalletDiagnosticStatus(
      WALLET_DESCRIPTOR,
      makeState(["@elizaos/plugin-wallet"]),
    );
    expect(status.enabled).toBe(true);
  });

  it("is disabled when neither loaded, required, nor allow-listed", () => {
    resolveWalletCapabilityStatusMock.mockReturnValue(makeCapability({}));
    const status = resolveWalletDiagnosticStatus(
      WALLET_DESCRIPTOR,
      makeState(["some-other-plugin"]),
    );
    expect(status.enabled).toBe(false);
    expect(status.capabilityStatus).toBe("disabled");
  });
});
