/** Verifies the routed Wallet header remains navigation-only. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAppShellPage } from "../../app-shell-registry";
import { resetUiRegistryHostForTests } from "../../registry-host";
import { WalletSectionNav } from "./WalletSectionNav";

function registerWalletPages(): void {
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
}

beforeEach(() => {
  resetUiRegistryHostForTests();
  registerWalletPages();
});

afterEach(() => {
  cleanup();
  resetUiRegistryHostForTests();
});

describe("WalletSectionNav canonical surface", () => {
  it.each(["/wallet", "/inventory", "/perps"])(
    "does not mount a duplicate balance surface on %s",
    (activePath) => {
      render(<WalletSectionNav activePath={activePath} />);

      expect(screen.queryByTestId("wallet-section-price-surface")).toBeNull();
      expect(screen.queryByTestId("chat-widget-wallet-prices")).toBeNull();
      expect(screen.getByRole("heading", { name: "Wallet" })).toBeTruthy();
    },
  );
});
