/**
 * Guards the wallet update-request network contract: missing or blank
 * stored status defaults to mainnet, valid values pass through, and
 * invalid values throw WALLET_NETWORK_INVALID instead of silently
 * becoming mainnet. Deterministic; executes production builders only.
 */

import { ElizaError } from "@elizaos/core/protocol";
import { describe, expect, it } from "vitest";
import { buildWalletRpcUpdateRequest } from "./wallet.js";
import type {
  WalletConfigStatus,
  WalletRpcSelections,
} from "./wallet-types.js";

const SELECTIONS: WalletRpcSelections = {
  evm: "eliza-cloud",
  bsc: "eliza-cloud",
  solana: "eliza-cloud",
};

function statusWith(network: unknown): WalletConfigStatus {
  return {
    evmAddress: null,
    solanaAddress: null,
    selectedRpcProviders: SELECTIONS,
    legacyCustomChains: [],
    alchemyKeySet: false,
    infuraKeySet: false,
    ankrKeySet: false,
    heliusKeySet: false,
    birdeyeKeySet: false,
    evmChains: [],
    walletNetwork: network as WalletConfigStatus["walletNetwork"],
  };
}

function requestFor(network: unknown, selectedNetwork?: "mainnet" | "testnet") {
  return buildWalletRpcUpdateRequest({
    walletConfig: statusWith(network),
    rpcFieldValues: {},
    selectedProviders: SELECTIONS,
    ...(selectedNetwork === undefined ? {} : { selectedNetwork }),
  });
}

describe("buildWalletRpcUpdateRequest walletNetwork", () => {
  it("defaults missing or blank stored status to mainnet", () => {
    expect(requestFor(undefined).walletNetwork).toBe("mainnet");
    expect(requestFor(null).walletNetwork).toBe("mainnet");
    expect(requestFor("   ").walletNetwork).toBe("mainnet");
  });

  it("preserves valid stored and explicit networks", () => {
    expect(requestFor("testnet").walletNetwork).toBe("testnet");
    expect(requestFor("MAINNET").walletNetwork).toBe("mainnet");
    expect(requestFor("mainnet", "testnet").walletNetwork).toBe("testnet");
  });

  it("rejects invalid stored status instead of routing to mainnet", () => {
    for (const bad of ["devnet", "true", "1"]) {
      let error: unknown;
      try {
        requestFor(bad);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("WALLET_NETWORK_INVALID");
    }
  });

  it("rejects invalid explicit selection", () => {
    expect(() =>
      requestFor("mainnet", "devnet" as unknown as "mainnet"),
    ).toThrowError(ElizaError);
  });
});
