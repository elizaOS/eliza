/** Verifies Calendar stays discoverable while launcher curation removes only its duplicate tile. */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { calendarPlugin } from "./plugin.js";

describe("plugin app metadata", () => {
  it("keeps connected Calendar discoverable outside the curated launcher", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(packageJson.elizaos?.app?.visibleInAppStore).not.toBe(false);
    expect(packageJson.elizaos?.app?.permissions).toEqual(["calendar"]);

    expect(calendarPlugin.views).toHaveLength(1);
    expect(calendarPlugin.views?.[0]).toMatchObject({
      id: "calendar",
      visibleInManager: true,
      desktopTabEnabled: true,
    });
  });
});
