import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/app-core/components", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/components")
  >("@elizaos/app-core/components");
  return {
    ...actual,
    BugReportModal: () => React.createElement("div", null, "BugReportModal"),
    CommandPalette: () => React.createElement("div", null, "CommandPalette"),
    RestartBanner: () => React.createElement("div", null, "RestartBanner"),
    ShortcutsOverlay: () =>
      React.createElement("div", null, "ShortcutsOverlay"),
  };
});

vi.mock("../../src/components/MemoryDebugPanel", () => ({
  MemoryDebugPanel: () => React.createElement("div", null, "MemoryDebugPanel"),
}));

import { ShellOverlays } from "../../src/components/ShellOverlays";

describe("ShellOverlays", () => {
  it("renders the shared overlay components once", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ShellOverlays, { actionNotice: null }),
    );

    expect(markup).toContain("CommandPalette");
    expect(markup).toContain("RestartBanner");

    expect(markup).toContain("BugReportModal");
    expect(markup).toContain("ShortcutsOverlay");
  });

  it.each([
    [{ text: "Saved", tone: "success" }, "bg-ok"],
    [{ text: "Failed", tone: "error" }, "bg-danger"],
    [{ text: "Working", tone: "info" }, "bg-accent"],
  ])("maps %o action notices to the expected tone class", (actionNotice, expectedClass) => {
    const markup = renderToStaticMarkup(
      React.createElement(ShellOverlays, { actionNotice }),
    );

    expect(markup).toContain(actionNotice.text);
    expect(markup).toContain(expectedClass);
  });
});
