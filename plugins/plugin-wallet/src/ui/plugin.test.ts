import { describe, expect, it } from "vitest";
import { walletAppPlugin } from "./plugin.ts";

describe("walletAppPlugin view declaration", () => {
  it("declares the wallet anticipatory greeting intent", () => {
    const walletView = walletAppPlugin.views?.find(
      (view) => view.id === "wallet",
    );

    expect(walletView?.anticipatoryIntent).toContain("portfolio summary");
    expect(walletView?.anticipatoryIntent).toContain("fund/swap");
  });
});
