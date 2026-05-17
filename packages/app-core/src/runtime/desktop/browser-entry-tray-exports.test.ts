import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESKTOP_TRAY_MENU_ITEMS } from "./DesktopTrayRuntime";

const browserEntryPath = fileURLToPath(
  new URL("../../browser.ts", import.meta.url),
);

describe("app-core browser desktop tray exports", () => {
  it("keeps the renderer-facing tray menu wired to the real desktop runtime", () => {
    const browserEntry = readFileSync(browserEntryPath, "utf8");

    expect(browserEntry).toContain("DESKTOP_TRAY_MENU_ITEMS");
    expect(browserEntry).toContain('from "./runtime/desktop"');
    expect(browserEntry).not.toContain("DESKTOP_TRAY_MENU_ITEMS = []");
    expect(DESKTOP_TRAY_MENU_ITEMS.some((item) => item.id === "quit")).toBe(
      true,
    );
  });
});
