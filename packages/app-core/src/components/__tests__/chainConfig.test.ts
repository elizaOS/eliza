/**
 * Unit tests for the central chain configuration registry.
 */
import { describe, expect, it } from "vitest";

import {
  CHAIN_CONFIGS,
  getChainConfig,
  getContractLogoUrl,
  getExplorerTokenUrl,
  getExplorerTxUrl,
  getNativeLogoUrl,
  getStablecoinAddress,
  PRIMARY_CHAIN_KEYS,
  resolveChainKey,
} from "../chainConfig";

describe("chainConfig", () => {
  // ── CHAIN_CONFIGS registry ──────────────────────────────────────
  describe("CHAIN_CONFIGS", () => {
    it("contains all primary chains", () => {
      for (const key of PRIMARY_CHAIN_KEYS) {
        expect(CHAIN_CONFIGS[key]).toBeDefined();
        expect(CHAIN_CONFIGS[key].chainKey).toBe(key);
      }
    });

    it("every config has required fields", () => {
      for (const config of Object.values(CHAIN_CONFIGS)) {
        expect(config.name).toBeTruthy();
        expect(config.nativeSymbol).toBeTruthy();
        expect(config.explorerBaseUrl).toMatch(/^https?:\/\//);
        expect(config.nativeLogoUrl).toMatch(/^https?:\/\//);
        expect(config.addressRegex).toBeInstanceOf(RegExp);
        expect(config.nameVariants.length).toBeGreaterThan(0);
      }
    });
  });

  // ── getChainConfig ──────────────────────────────────────────────
  describe("getChainConfig", () => {
    it("resolves BSC chain names", () => {
      expect(getChainConfig("bsc")?.chainKey).toBe("bsc");
      expect(getChainConfig("BNB Chain")?.chainKey).toBe("bsc");
      expect(getChainConfig("BNB Smart Chain")?.chainKey).toBe("bsc");
    });

    it("resolves AVAX chain names", () => {
      expect(getChainConfig("avax")?.chainKey).toBe("avax");
      expect(getChainConfig("Avalanche")?.chainKey).toBe("avax");
      expect(getChainConfig("c-chain")?.chainKey).toBe("avax");
      expect(getChainConfig("avalanche c-chain")?.chainKey).toBe("avax");
    });

    it("resolves Solana chain names", () => {
      expect(getChainConfig("solana")?.chainKey).toBe("solana");
      expect(getChainConfig("SOL")?.chainKey).toBe("solana");
    });

    it("resolves Ethereum chain names", () => {
      expect(getChainConfig("ethereum")?.chainKey).toBe("ethereum");
      expect(getChainConfig("mainnet")?.chainKey).toBe("ethereum");
      expect(getChainConfig("eth")?.chainKey).toBe("ethereum");
    });

    it("trims whitespace and is case-insensitive", () => {
      expect(getChainConfig("  AVAX  ")?.chainKey).toBe("avax");
      expect(getChainConfig("  BSC  ")?.chainKey).toBe("bsc");
    });

    it("returns null for unknown chains", () => {
      expect(getChainConfig("fantom")).toBeNull();
      expect(getChainConfig("")).toBeNull();
    });
  });

  // ── resolveChainKey ─────────────────────────────────────────────
  describe("resolveChainKey", () => {
    it("returns the chain key for known chains", () => {
      expect(resolveChainKey("avalanche")).toBe("avax");
      expect(resolveChainKey("bsc")).toBe("bsc");
      expect(resolveChainKey("solana")).toBe("solana");
    });

    it("returns null for unknowns", () => {
      expect(resolveChainKey("fantom")).toBeNull();
    });
  });

  // ── getExplorerTokenUrl ─────────────────────────────────────────
  describe("getExplorerTokenUrl", () => {
    const validAddr = `0x${"a".repeat(40)}`;
    const solAddr = "So11111111111111111111111111111111111111112";

    it("returns bscscan URL for BSC", () => {
      expect(getExplorerTokenUrl("bsc", validAddr)).toBe(
        `https://bscscan.com/token/${validAddr}`,
      );
    });

    it("returns snowtrace URL for Avalanche", () => {
      expect(getExplorerTokenUrl("avalanche", validAddr)).toBe(
        `https://snowtrace.io/token/${validAddr}`,
      );
    });

    it("returns solscan URL for Solana", () => {
      expect(getExplorerTokenUrl("solana", solAddr)).toBe(
        `https://solscan.io/token/${solAddr}`,
      );
    });

    it("returns null for unknown chains", () => {
      expect(getExplorerTokenUrl("fantom", validAddr)).toBeNull();
    });

    it("returns null for invalid addresses", () => {
      expect(getExplorerTokenUrl("bsc", "not-an-address")).toBeNull();
    });
  });

  // ── getExplorerTxUrl ────────────────────────────────────────────
  describe("getExplorerTxUrl", () => {
    const hash = `0x${"f".repeat(64)}`;

    it("returns bscscan tx URL", () => {
      expect(getExplorerTxUrl("bsc", hash)).toBe(
        `https://bscscan.com/tx/${hash}`,
      );
    });

    it("returns snowtrace tx URL", () => {
      expect(getExplorerTxUrl("avax", hash)).toBe(
        `https://snowtrace.io/tx/${hash}`,
      );
    });

    it("returns null for unknown chains", () => {
      expect(getExplorerTxUrl("fantom", hash)).toBeNull();
    });
  });

  // ── getNativeLogoUrl ────────────────────────────────────────────
  describe("getNativeLogoUrl", () => {
    it("returns logo URL for known chains", () => {
      expect(getNativeLogoUrl("bsc")).toMatch(/smartchain/);
      expect(getNativeLogoUrl("avax")).toMatch(/avalanchec/);
      expect(getNativeLogoUrl("solana")).toMatch(/solana/);
      expect(getNativeLogoUrl("ethereum")).toMatch(/ethereum/);
    });

    it("returns null for unknown chains", () => {
      expect(getNativeLogoUrl("fantom")).toBeNull();
    });
  });

  // ── getContractLogoUrl ──────────────────────────────────────────
  describe("getContractLogoUrl", () => {
    const addr = `0x${"a".repeat(40)}`;

    it("returns TrustWallet CDN URL for BSC", () => {
      const url = getContractLogoUrl("bsc", addr);
      expect(url).toMatch(/smartchain.*assets/);
      expect(url).toContain(addr);
    });

    it("returns TrustWallet CDN URL for AVAX", () => {
      const url = getContractLogoUrl("avalanche", addr);
      expect(url).toMatch(/avalanchec.*assets/);
    });

    it("returns null when no contract address", () => {
      expect(getContractLogoUrl("bsc", null)).toBeNull();
    });

    it("returns null for chains without TrustWallet slug", () => {
      expect(getContractLogoUrl("arbitrum", addr)).toBeNull();
    });
  });

  // ── getStablecoinAddress ────────────────────────────────────────
  describe("getStablecoinAddress", () => {
    it("returns USDT address for BSC", () => {
      const addr = getStablecoinAddress("bsc", "USDT");
      expect(addr).toBeTruthy();
      expect(addr).toMatch(/^0x/);
    });

    it("returns USDC address for Avalanche", () => {
      const addr = getStablecoinAddress("avax", "USDC");
      expect(addr).toBeTruthy();
      expect(addr).toMatch(/^0x/);
    });

    it("is case-insensitive for symbol", () => {
      expect(getStablecoinAddress("bsc", "usdt")).toBe(
        getStablecoinAddress("bsc", "USDT"),
      );
    });

    it("returns null for unknown stablecoin", () => {
      expect(getStablecoinAddress("bsc", "DAI")).toBeNull();
    });

    it("returns null for unknown chain", () => {
      expect(getStablecoinAddress("fantom", "USDT")).toBeNull();
    });
  });

  // ── PRIMARY_CHAIN_KEYS ──────────────────────────────────────────
  describe("PRIMARY_CHAIN_KEYS", () => {
    it("includes BSC, AVAX, and Solana", () => {
      expect(PRIMARY_CHAIN_KEYS).toContain("ethereum");
      expect(PRIMARY_CHAIN_KEYS).toContain("base");
      expect(PRIMARY_CHAIN_KEYS).toContain("bsc");
      expect(PRIMARY_CHAIN_KEYS).toContain("avax");
      expect(PRIMARY_CHAIN_KEYS).toContain("solana");
    });
  });
});
