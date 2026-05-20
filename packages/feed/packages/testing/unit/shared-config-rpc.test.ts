import { afterEach, describe, expect, it } from "bun:test";
import { sepolia } from "viem/chains";
import {
  getCurrentChainId,
  getRpcUrlForChainId,
} from "../../shared/src/config";

const originalChainId = process.env.CHAIN_ID;
const originalNextPublicChainId = process.env.NEXT_PUBLIC_CHAIN_ID;
const originalRpcUrl = process.env.RPC_URL;
const originalNextPublicRpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

function restoreEnv() {
  process.env.CHAIN_ID = originalChainId;
  process.env.NEXT_PUBLIC_CHAIN_ID = originalNextPublicChainId;
  process.env.RPC_URL = originalRpcUrl;
  process.env.NEXT_PUBLIC_RPC_URL = originalNextPublicRpcUrl;
}

describe("shared RPC configuration", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("supports plain CHAIN_ID overrides", () => {
    delete process.env.NEXT_PUBLIC_CHAIN_ID;
    process.env.CHAIN_ID = "1";

    expect(getCurrentChainId()).toBe(1);
  });

  it("returns the canonical ethereum RPC when no override is provided", () => {
    delete process.env.RPC_URL;
    delete process.env.NEXT_PUBLIC_RPC_URL;

    expect(getRpcUrlForChainId(1)).toBe("https://eth.llamarpc.com");
  });

  it("preserves viem defaults for supported chains outside public config", () => {
    delete process.env.RPC_URL;
    delete process.env.NEXT_PUBLIC_RPC_URL;

    expect(getRpcUrlForChainId(sepolia.id)).toBe(
      sepolia.rpcUrls.default.http[0],
    );
  });

  it("prefers explicit RPC overrides and trims whitespace", () => {
    process.env.RPC_URL = "  https://rpc.example  ";
    delete process.env.NEXT_PUBLIC_RPC_URL;

    expect(getRpcUrlForChainId(1)).toBe("https://rpc.example");
  });
});
