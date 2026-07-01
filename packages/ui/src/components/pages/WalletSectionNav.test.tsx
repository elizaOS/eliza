// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isWalletSectionPath, WalletSectionNav } from "./WalletSectionNav";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("isWalletSectionPath", () => {
  it("matches wallet + its sub-view routes", () => {
    for (const path of [
      "/wallet",
      "/inventory",
      "/hyperliquid",
      "/polymarket",
      "/hyperliquid?tab=positions",
    ]) {
      expect(isWalletSectionPath(path)).toBe(true);
    }
  });

  it("rejects unrelated routes", () => {
    for (const path of ["/browser", "/automations", "/apps/logs", "/"]) {
      expect(isWalletSectionPath(path)).toBe(false);
    }
  });
});

describe("WalletSectionNav", () => {
  it("marks the active sub-view (aliases resolve to Wallet)", () => {
    render(<WalletSectionNav activePath="/inventory" />);
    expect(
      screen.getByRole("button", { name: "Wallet" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("button", { name: "Perps" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks Perps active on the hyperliquid route", () => {
    render(<WalletSectionNav activePath="/hyperliquid" />);
    expect(
      screen.getByRole("button", { name: "Perps" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("navigates to the sub-view route on click", () => {
    render(<WalletSectionNav activePath="/wallet" />);
    fireEvent.click(screen.getByRole("button", { name: "Predictions" }));
    expect(window.location.pathname).toBe("/polymarket");
  });

  it("does not renavigate when the active tab is clicked", () => {
    window.history.replaceState(null, "", "/wallet");
    render(<WalletSectionNav activePath="/wallet" />);
    fireEvent.click(screen.getByRole("button", { name: "Wallet" }));
    expect(window.location.pathname).toBe("/wallet");
  });
});
