/**
 * The page-world wallet shim must not treat a junk chain id as Ethereum
 * mainnet. `parseInt("0x1g", 16)` is 1, and `wallet_switchEthereumChain`
 * stored that string and resolved.
 */
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildWalletShim } from "./build-shim";

interface EvmProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function installShim(): EvmProvider {
  const window: {
    ethereum?: EvmProvider;
    addEventListener: () => void;
    dispatchEvent: () => boolean;
    crypto: { randomUUID: () => string };
  } = {
    addEventListener: () => {},
    dispatchEvent: () => true,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  const script = buildWalletShim({
    apiBase: "http://127.0.0.1:31337",
    signToken: "test-sign-token-1234567890",
    solanaPublicKey: null,
    evmAddress: "0x1111111111111111111111111111111111111111",
    evmChainId: 1,
  });
  vm.runInNewContext(script, {
    CustomEvent: class CustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail: unknown }) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    TextEncoder,
    Uint8Array,
    atob,
    btoa,
    console,
    fetch: vi.fn(async () => ({
      ok: true,
      json: async () => ({ hash: "0xabc" }),
      text: async () => "",
    })),
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
    window,
  });
  if (!window.ethereum) throw new Error("shim did not install ethereum");
  return window.ethereum;
}

describe("wallet shim chain switch", () => {
  it("rejects a junk hex chain id and stays on the chain it already switched to", async () => {
    const ethereum = installShim();
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });
    expect(await ethereum.request({ method: "eth_chainId" })).toBe("0x89");

    await expect(
      ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x1g" }],
      }),
    ).rejects.toThrow(/valid chainId/);
    expect(await ethereum.request({ method: "eth_chainId" })).toBe("0x89");
  });
});
