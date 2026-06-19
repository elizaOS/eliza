import { describe, expect, it } from "bun:test";
import {
  DEFAULT_WALLET_TAB,
  getWalletTabHref,
  parseWalletTab,
} from "./wallet-tabs";

describe("parseWalletTab", () => {
  it("returns balance for the balance tab query param", () => {
    expect(parseWalletTab("balance")).toBe("balance");
  });

  it("returns positions for the positions tab query param", () => {
    expect(parseWalletTab("positions")).toBe("positions");
  });

  it("returns pnl for the pnl tab query param", () => {
    expect(parseWalletTab("pnl")).toBe("pnl");
  });

  it("falls back to the default tab when the query param is missing", () => {
    expect(parseWalletTab(null)).toBe(DEFAULT_WALLET_TAB);
    expect(parseWalletTab(undefined)).toBe(DEFAULT_WALLET_TAB);
  });

  it("falls back to the default tab when the query param is invalid", () => {
    expect(parseWalletTab("not-a-tab")).toBe(DEFAULT_WALLET_TAB);
  });
});

describe("getWalletTabHref", () => {
  it("builds the balance wallet tab URL", () => {
    expect(getWalletTabHref("balance")).toBe("/wallet?tab=balance");
  });

  it("builds the positions wallet tab URL", () => {
    expect(getWalletTabHref("positions")).toBe("/wallet?tab=positions");
  });

  it("builds the pnl wallet tab URL", () => {
    expect(getWalletTabHref("pnl")).toBe("/wallet?tab=pnl");
  });
});
