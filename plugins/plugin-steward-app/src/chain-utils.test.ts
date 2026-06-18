import { describe, expect, it } from "vitest";
import {
  formatWeiValue,
  getChainName,
  getChainSymbol,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  truncateAddress,
} from "./chain-utils";

describe("getChainName", () => {
  it("maps known chain ids to their display names", () => {
    expect(getChainName(1)).toBe("Ethereum");
    expect(getChainName(8453)).toBe("Base");
    expect(getChainName(56)).toBe("BSC");
    expect(getChainName(101)).toBe("Solana");
  });

  it("falls back to a generic label for unknown chain ids", () => {
    expect(getChainName(999999)).toBe("Chain 999999");
  });
});

describe("getChainSymbol", () => {
  it("maps known chain ids to their native symbol", () => {
    expect(getChainSymbol(1)).toBe("ETH");
    expect(getChainSymbol(56)).toBe("BNB");
    expect(getChainSymbol(137)).toBe("POL");
    expect(getChainSymbol(101)).toBe("SOL");
  });

  it("falls back to ??? for unknown chain ids", () => {
    expect(getChainSymbol(424242)).toBe("???");
  });
});

describe("getExplorerTxUrl", () => {
  it("builds an EVM explorer URL", () => {
    expect(getExplorerTxUrl(1, "0xabc")).toBe("https://etherscan.io/tx/0xabc");
    expect(getExplorerTxUrl(8453, "0xdef")).toBe(
      "https://basescan.org/tx/0xdef",
    );
  });

  it("builds a Solana mainnet URL without a cluster query", () => {
    expect(getExplorerTxUrl(101, "sig123")).toBe(
      "https://solscan.io/tx/sig123",
    );
  });

  it("appends ?cluster=devnet for Solana devnet", () => {
    expect(getExplorerTxUrl(102, "sig123")).toBe(
      "https://solscan.io/tx/sig123?cluster=devnet",
    );
  });

  it("returns null when chain is unknown or the hash is missing", () => {
    expect(getExplorerTxUrl(999999, "0xabc")).toBeNull();
    expect(getExplorerTxUrl(1, "")).toBeNull();
  });
});

describe("getExplorerAddressUrl", () => {
  it("uses /address for EVM and /account for Solana", () => {
    expect(getExplorerAddressUrl(1, "0xabc")).toBe(
      "https://etherscan.io/address/0xabc",
    );
    expect(getExplorerAddressUrl(102, "acct")).toBe(
      "https://solscan.io/account/acct?cluster=devnet",
    );
  });
});

describe("truncateAddress", () => {
  it("returns the input unchanged when shorter than the cutoff", () => {
    expect(truncateAddress("0x1234")).toBe("0x1234");
    expect(truncateAddress("")).toBe("");
  });

  it("truncates a long address with an ellipsis around the default 6 chars", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    // chars=6 -> first 8 (0x + 6) … last 6
    expect(truncateAddress(addr)).toBe("0x123456…345678");
  });

  it("respects a custom char count", () => {
    const hash = "0xabcdef0123456789";
    expect(truncateAddress(hash, 4)).toBe("0xabcd…6789");
  });
});

describe("formatWeiValue", () => {
  it("formats 18-decimal EVM wei into a token amount", () => {
    expect(formatWeiValue("1000000000000000000", 1)).toBe("1 ETH");
    expect(formatWeiValue("500000000000000000", 8453)).toBe("0.5 ETH");
  });

  it("formats 9-decimal Solana lamports into SOL", () => {
    expect(formatWeiValue("1000000000", 101)).toBe("1 SOL");
    expect(formatWeiValue("1500000000", 101)).toBe("1.5 SOL");
  });

  it("trims the fraction to 6 places and strips trailing zeros", () => {
    // 1.123456789 ETH -> truncated to 6 fractional digits
    expect(formatWeiValue("1123456789000000000", 1)).toBe("1.123456 ETH");
    // trailing zeros removed
    expect(formatWeiValue("1100000000000000000", 1)).toBe("1.1 ETH");
  });

  it("renders a whole-number amount without a decimal point", () => {
    expect(formatWeiValue("2000000000000000000", 1)).toBe("2 ETH");
    expect(formatWeiValue("0", 1)).toBe("0 ETH");
  });

  it("falls back to a raw '<value> wei' string on non-numeric input", () => {
    expect(formatWeiValue("not-a-number", 1)).toBe("not-a-number wei");
  });
});
