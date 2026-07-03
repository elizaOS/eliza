// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAppShellPage } from "../../app-shell-registry";
import { resetUiRegistryHostForTests } from "../../registry-host";
import { isWalletSectionPath, WalletSectionNav } from "./WalletSectionNav";

function registerWalletSectionPages(): void {
  registerAppShellPage({
    id: "test.wallet",
    pluginId: "test-wallet",
    label: "Wallet",
    path: "/inventory",
    tabAffinity: "inventory",
    group: "wallet",
    order: 10,
    loader: async () => ({ default: () => null }),
  });
  registerAppShellPage({
    id: "test.perps",
    pluginId: "test-perps",
    label: "Perps",
    path: "/perps",
    tabAffinity: "inventory",
    group: "wallet",
    order: 20,
    loader: async () => ({ default: () => null }),
  });
  registerAppShellPage({
    id: "test.predictions",
    pluginId: "test-predictions",
    label: "Predictions",
    path: "/predictions",
    tabAffinity: "inventory",
    group: "wallet",
    order: 30,
    loader: async () => ({ default: () => null }),
  });
}

beforeEach(() => {
  resetUiRegistryHostForTests();
  registerWalletSectionPages();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  resetUiRegistryHostForTests();
});

describe("isWalletSectionPath", () => {
  it("matches wallet + registered sub-view routes", () => {
    for (const path of [
      "/wallet",
      "/inventory",
      "/perps",
      "/predictions",
      "/perps?tab=positions",
    ]) {
      expect(isWalletSectionPath(path)).toBe(true);
    }
  });

  it("rejects unrelated routes", () => {
    for (const path of ["/browser", "/automations", "/apps/logs", "/"]) {
      expect(isWalletSectionPath(path)).toBe(false);
    }
  });

  it("stops matching a sub-view when its app-shell registration is absent", () => {
    resetUiRegistryHostForTests();
    registerAppShellPage({
      id: "test.wallet",
      pluginId: "test-wallet",
      label: "Wallet",
      path: "/inventory",
      tabAffinity: "inventory",
      group: "wallet",
      order: 10,
      loader: async () => ({ default: () => null }),
    });

    expect(isWalletSectionPath("/perps")).toBe(false);
    expect(isWalletSectionPath("/wallet")).toBe(true);
  });
});

describe("WalletSectionNav", () => {
  it("marks the active sub-view (aliases resolve to Wallet)", () => {
    render(<WalletSectionNav activePath="/inventory" />);
    expect(
      screen
        .getByRole("button", { name: "Wallet" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("button", { name: "Perps" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks Perps active on its registered route", () => {
    render(<WalletSectionNav activePath="/perps" />);
    expect(
      screen
        .getByRole("button", { name: "Perps" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("navigates to the sub-view route on click", () => {
    render(<WalletSectionNav activePath="/wallet" />);
    fireEvent.click(screen.getByRole("button", { name: "Predictions" }));
    expect(window.location.pathname).toBe("/predictions");
  });

  it("does not renavigate when the active tab is clicked", () => {
    window.history.replaceState(null, "", "/wallet");
    render(<WalletSectionNav activePath="/wallet" />);
    fireEvent.click(screen.getByRole("button", { name: "Wallet" }));
    expect(window.location.pathname).toBe("/wallet");
  });
});
