import { describe, expect, it } from "vitest";
import { isSupportedLoginChainId, readWalletChainId } from "./cloud-siwe-login";

function providerReturning(chainId: unknown) {
  return {
    request: async () => chainId,
  };
}

describe("readWalletChainId", () => {
  it("rejects a hex chain id that contains a non-hex character", async () => {
    // parseInt("1g", 16) is 1. A junk eth_chainId must not become mainnet.
    expect(await readWalletChainId(providerReturning("0x1g"))).toBeNull();
  });

  it("rejects junk that would otherwise parse as a supported login chain", async () => {
    // Base is 0x2105. parseInt("2105g", 16) is 8453, which login accepts.
    expect(isSupportedLoginChainId(8453)).toBe(true);
    expect(await readWalletChainId(providerReturning("0x2105g"))).toBeNull();
  });

  it("still accepts Base and BSC hex chain ids", async () => {
    expect(await readWalletChainId(providerReturning("0x2105"))).toBe(8453);
    expect(await readWalletChainId(providerReturning("0x38"))).toBe(56);
  });
});
