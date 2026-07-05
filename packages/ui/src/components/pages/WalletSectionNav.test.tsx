// @vitest-environment jsdom

/**
 * jsdom tests for `WalletSectionNav` and `isWalletSectionPath`: exercises the
 * real app-shell page registry to confirm active-route matching, alias
 * resolution to Wallet, and that a sub-view stops matching when its registration
 * is absent.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
  it("renders a centered Wallet title header with an icon-only back button", () => {
    render(<WalletSectionNav activePath="/inventory" />);
    // Uniform ViewHeader geometry (#13451/#13592): centered title + bare back.
    const header = screen.getByTestId("view-header");
    expect(
      within(header).getByRole("heading", { name: "Wallet" }),
    ).toBeTruthy();
    expect(
      within(header).getByRole("button", { name: "Back to launcher" }),
    ).toBeTruthy();
  });

  it("suppresses the secondary strip when only one group member is registered", () => {
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
    render(<WalletSectionNav activePath="/wallet" />);
    // Header present, but no switchable strip with a single member.
    expect(screen.getByTestId("view-header")).toBeTruthy();
    expect(screen.queryByTestId("section-nav-wallet")).toBeNull();
  });

  it("marks the active sub-view (aliases resolve to Wallet)", () => {
    render(<WalletSectionNav activePath="/inventory" />);
    const strip = screen.getByTestId("section-nav-wallet");
    expect(
      within(strip)
        .getByRole("button", { name: "Wallet" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(strip)
        .getByRole("button", { name: "Perps" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks Perps active on its registered route", () => {
    render(<WalletSectionNav activePath="/perps" />);
    const strip = screen.getByTestId("section-nav-wallet");
    expect(
      within(strip)
        .getByRole("button", { name: "Perps" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("navigates to the sub-view route on click", () => {
    render(<WalletSectionNav activePath="/wallet" />);
    const strip = screen.getByTestId("section-nav-wallet");
    fireEvent.click(within(strip).getByRole("button", { name: "Predictions" }));
    expect(window.location.pathname).toBe("/predictions");
  });

  it("does not renavigate when the active tab is clicked", () => {
    window.history.replaceState(null, "", "/wallet");
    render(<WalletSectionNav activePath="/wallet" />);
    const strip = screen.getByTestId("section-nav-wallet");
    fireEvent.click(within(strip).getByRole("button", { name: "Wallet" }));
    expect(window.location.pathname).toBe("/wallet");
  });
});
