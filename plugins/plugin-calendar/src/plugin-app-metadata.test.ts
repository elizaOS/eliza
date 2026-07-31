/** Verifies the connected-calendar manifest stays a permission provider rather than a duplicate launcher app. */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { calendarPlugin } from "./plugin.js";

describe("plugin app metadata", () => {
  it("keeps connected Calendar out of the app catalog while Simple Calendar is the product surface", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(packageJson.elizaos?.app).toMatchObject({
      visibleInAppStore: false,
      permissions: ["calendar"],
    });

    expect(calendarPlugin.views).toHaveLength(1);
    expect(calendarPlugin.views?.[0]).toMatchObject({
      id: "calendar",
      visibleInManager: false,
      desktopTabEnabled: false,
    });
  });
});
