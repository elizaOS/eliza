/**
 * Chain config drives explorer links + address validation in the wallet UI.
 * Lookups are case-insensitive and null for unknown chains; explorer URLs
 * embed the hash/address; token URLs reject addresses failing the chain's
 * address regex (so a bad address never produces a misleading link).
 */
import { describe, expect, it } from "vitest";
import {
  getChainConfig,
  getExplorerTokenUrl,
  getExplorerTxUrl,
  getNativeLogoUrl,
  resolveChainKey,
} from "./chainConfig.js";

describe("getChainConfig / resolveChainKey", () => {
  it("resolves known chains case-insensitively, null for unknown", () => {
    expect(getChainConfig("ethereum")).not.toBeNull();
    expect(getChainConfig("Ethereum")).not.toBeNull();
    expect(getChainConfig("totally-fake-chain")).toBeNull();
    expect(resolveChainKey("ethereum")).toBe("ethereum");
    expect(resolveChainKey("nope")).toBeNull();
  });
});

describe("explorer URLs", () => {
  it("getExplorerTxUrl embeds the hash, null for unknown chain", () => {
    const url = getExplorerTxUrl("ethereum", "0xDEADBEEF");
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain("0xDEADBEEF");
    expect(getExplorerTxUrl("nope", "0x1")).toBeNull();
  });

  it("getExplorerTokenUrl validates the address against the chain regex", () => {
    const valid = `0x${"a".repeat(40)}`;
    const url = getExplorerTokenUrl("ethereum", valid);
    expect(url).toContain(valid);
    expect(getExplorerTokenUrl("ethereum", "not-an-address")).toBeNull();
    expect(getExplorerTokenUrl("nope", valid)).toBeNull();
  });
});

describe("getNativeLogoUrl", () => {
  it("returns a logo url for a known chain, null otherwise", () => {
    expect(typeof getNativeLogoUrl("ethereum")).toBe("string");
    expect(getNativeLogoUrl("totally-fake-chain")).toBeNull();
  });
});
