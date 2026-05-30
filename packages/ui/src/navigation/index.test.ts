import { describe, expect, it } from "vitest";
import { registerAppShellPage } from "../app-shell-registry";
import { pathForTab, tabFromPath } from ".";

function TestPage() {
  return null;
}

describe("navigation route resolution", () => {
  it("keeps wallet direct routes mapped to the wallet tab", () => {
    expect(pathForTab("inventory")).toBe("/wallet");
    expect(tabFromPath("/wallet")).toBe("inventory");
    expect(tabFromPath("/inventory")).toBe("inventory");
  });

  it("keeps the phone companion direct route addressable", () => {
    expect(pathForTab("phone-companion")).toBe("/phone-companion");
    expect(tabFromPath("/phone-companion")).toBe("phone-companion");
  });

  it("resolves registered top-level app-shell page paths before view fallback", () => {
    registerAppShellPage({
      id: "test.registered-page",
      pluginId: "@elizaos/test",
      label: "Registered Page",
      path: "/registered-page",
      Component: TestPage,
    });

    expect(tabFromPath("/registered-page")).toBe("test.registered-page");
  });

  it("resolves registered nested app-shell page paths before generic app slugs", () => {
    registerAppShellPage({
      id: "test.registered-tui",
      pluginId: "@elizaos/test",
      label: "Registered TUI",
      path: "/apps/registered/tui",
      Component: TestPage,
    });

    expect(tabFromPath("/apps/registered/tui")).toBe("test.registered-tui");
  });
});
