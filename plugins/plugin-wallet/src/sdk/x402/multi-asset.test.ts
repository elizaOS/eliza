import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSupportedAssets,
  isStablecoin,
  parseNetworkChainId,
  resolveAssetAddress,
  resolveAssetDecimals,
} from "./multi-asset.js";

const { getToken, getTokenByAddress, USDC_BASE, WETH_BASE } = vi.hoisted(
  () => ({
    getToken: vi.fn(),
    getTokenByAddress: vi.fn(),
    USDC_BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH_BASE: "0x4200000000000000000000000000000000000006",
  }),
);

vi.mock("../tokens/registry.js", () => ({
  getGlobalRegistry: () => ({ getToken, getTokenByAddress }),
}));

vi.mock("./types.js", () => ({
  USDC_ADDRESSES: { "base:8453": USDC_BASE },
}));

beforeEach(() => {
  getToken.mockReset();
  getTokenByAddress.mockReset();
});

describe("parseNetworkChainId", () => {
  it("extracts the trailing chain id", () => {
    expect(parseNetworkChainId("base:8453")).toBe(8453);
    expect(parseNetworkChainId("arbitrum:42161")).toBe(42161);
  });

  it("rejects non-numeric ids and malformed networks", () => {
    expect(parseNetworkChainId("base:not-a-number")).toBeNull();
    expect(parseNetworkChainId("base:8453:extra")).toBeNull();
    expect(parseNetworkChainId("base")).toBeNull();
    expect(parseNetworkChainId("base:")).toBeNull();
    expect(parseNetworkChainId("")).toBeNull();
  });
});

describe("resolveAssetAddress", () => {
  it("resolves a symbol via the registry", () => {
    getToken.mockReturnValue({ address: WETH_BASE });
    expect(resolveAssetAddress("weth", "base:8453")).toBe(WETH_BASE);
    expect(getToken).toHaveBeenCalledWith("WETH", 8453);
  });

  it("rejects unknown hex addresses for safety", () => {
    getTokenByAddress.mockReturnValue(null);
    expect(
      resolveAssetAddress(
        "0x1111111111111111111111111111111111111111",
        "base:8453",
      ),
    ).toBeNull();
  });

  it("accepts a registered hex address", () => {
    getTokenByAddress.mockReturnValue({ address: WETH_BASE });
    expect(resolveAssetAddress(WETH_BASE, "base:8453")).toBe(WETH_BASE);
  });

  it("returns null for an unparseable network", () => {
    expect(resolveAssetAddress("USDC", "garbage")).toBeNull();
  });
});

describe("resolveAssetDecimals", () => {
  it("returns registered decimals by address", () => {
    getTokenByAddress.mockReturnValue({ address: WETH_BASE, decimals: 18 });
    expect(resolveAssetDecimals(WETH_BASE, "base:8453")).toBe(18);
  });

  it("defaults to 18 for unknown tokens", () => {
    getTokenByAddress.mockReturnValue(null);
    getToken.mockReturnValue(null);
    expect(
      resolveAssetDecimals(
        "0x9999999999999999999999999999999999999999",
        "base:8453",
      ),
    ).toBe(18);
    expect(resolveAssetDecimals("UNKNOWN_SYMBOL", "base:8453")).toBe(18);
  });

  it("does not default a non-USDC asset to 6 decimals when the network is unparseable", () => {
    // A malformed network string (e.g. from an untrusted 402 response) must
    // not be treated as a stablecoin: the documented fallback for unknown
    // assets is 18 decimals, otherwise payment amounts are mis-formatted.
    expect(resolveAssetDecimals(WETH_BASE, "base")).toBe(18);
    expect(resolveAssetDecimals(WETH_BASE, "base:not-a-number")).toBe(18);
  });

  it("keeps 6 for assets the registry confirms are 6-decimal", () => {
    getTokenByAddress.mockReturnValue({ address: USDC_BASE, decimals: 6 });
    expect(resolveAssetDecimals(USDC_BASE, "base:8453")).toBe(6);
  });
});

describe("buildSupportedAssets", () => {
  it("populates registered non-native symbols per network", () => {
    getToken.mockImplementation((symbol: string) =>
      symbol === "WETH" ? { address: WETH_BASE, isNative: false } : null,
    );
    const result = buildSupportedAssets(["base:8453"], ["WETH"]);
    expect(result["base:8453"]).toContain(WETH_BASE);
  });

  it("skips native tokens and unparseable networks", () => {
    getToken.mockReturnValue({ address: "0xeth", isNative: true });
    const result = buildSupportedAssets(["base:8453", "garbage"], ["ETH"]);
    expect(result.garbage).toBeUndefined();
  });

  it("appends the USDC fallback when not already present", () => {
    getToken.mockReturnValue(null);
    const result = buildSupportedAssets(["base:8453"], ["WETH"]);
    expect(result["base:8453"]).toContain(USDC_BASE);
  });
});

describe("isStablecoin", () => {
  it("classifies by resolved decimals", () => {
    getTokenByAddress.mockReturnValue({ address: USDC_BASE, decimals: 6 });
    expect(isStablecoin(USDC_BASE, "base:8453")).toBe(true);
    getTokenByAddress.mockReturnValue({ address: WETH_BASE, decimals: 18 });
    expect(isStablecoin(WETH_BASE, "base:8453")).toBe(false);
  });
});
