import { describe, expect, it } from "vitest";
import { resolveBuiltinRoutedViewManifest } from "./builtin-tab-registry";
import { routedShellMainClass } from "./routed-shell-layout";

const expectFlushCanvas = (tab: string) => {
  const className = routedShellMainClass(tab);
  expect(className).not.toContain("px-2");
  expect(className).not.toContain("sm:px-3");
  expect(className).not.toContain("pt-[var(--view-pad-top)]");
};

describe("routed shell layout", () => {
  it.each([
    "apps",
    "views",
    "background",
    "settings",
    "inventory",
    "documents",
    "notes",
    "calendar",
    "memories",
    "trajectories",
  ])("keeps the %s canvas flush with the shell", expectFlushCanvas);

  it.each([
    "custom-plugin",
    "notes-preview",
    "calendar-feed",
    "memories-export",
    "trajectories-debug",
  ])("keeps the default gutter for the distinct %s tab identity", (tab) => {
    const className = routedShellMainClass(tab);
    expect(className).toContain("px-2");
    expect(className).toContain("sm:px-3");
    expect(className).toContain("pt-[var(--view-pad-top)]");
  });

  it("leaves Browser on its deliberate fullscreen shell path", () => {
    expect(resolveBuiltinRoutedViewManifest("browser")?.header).toBe(
      "fullscreen",
    );
    expect(routedShellMainClass("browser")).toContain("px-2");
  });
});
