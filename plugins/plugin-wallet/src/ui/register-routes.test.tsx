/**
 * Verifies the wallet shell registrations against the real app-shell registry,
 * navigation resolver, and icon resolver: the Crypto Terminal route must stay
 * inside the Wallet launcher family without displacing the inventory root.
 */
// @vitest-environment jsdom

import { listAppShellPages } from "@elizaos/ui/app-shell-registry";
import { ALL_TAB_GROUPS, tabFromPath } from "@elizaos/ui/navigation";
import { ViewIcon } from "@elizaos/ui/views/ViewIcon";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "./register-routes.ts";
import { walletAppPlugin } from "./plugin.ts";

afterEach(() => cleanup());

describe("wallet shell registrations", () => {
  it("routes /crypto to the Wallet family tab", () => {
    expect(tabFromPath("/crypto")).toBe("inventory");
    expect(tabFromPath("/inventory")).toBe("inventory");
  });

  it("keeps the inventory page as the Wallet launcher root", () => {
    const walletGroup = ALL_TAB_GROUPS.find(
      (group) => group.label === "Wallet",
    );
    expect(walletGroup?.tabs).toEqual(["inventory", "wallet.terminal"]);
  });

  it("declares matching shell pages and nav tabs", () => {
    const pages = listAppShellPages().filter(
      (entry) => entry.pluginId === "app-wallet",
    );
    for (const navTab of walletAppPlugin.app?.navTabs ?? []) {
      const page = pages.find((entry) => entry.id === navTab.id);
      expect(page, navTab.id).toBeDefined();
      expect(page?.path).toBe(navTab.path);
      expect(page?.tabAffinity).toBe(navTab.tabAffinity);
      expect(page?.order).toBe(navTab.order);
      expect(page?.icon).toBe(navTab.icon);
    }
  });

  it("uses icon names the shell resolves to their own glyph", () => {
    const icons = [
      ...listAppShellPages()
        .filter((entry) => entry.pluginId === "app-wallet")
        .map((entry) => entry.icon),
      ...(walletAppPlugin.views ?? []).map((view) => view.icon),
    ];
    for (const icon of icons) {
      expect(icon).toBeTypeOf("string");
      const named = render(<ViewIcon icon={icon} label="" id="" />);
      const fallback = render(<ViewIcon icon={null} label="" id="" />);
      expect(named.container.innerHTML, String(icon)).not.toBe(
        fallback.container.innerHTML,
      );
    }
  });
});
