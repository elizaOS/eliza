/** Exercises explicit Relationships registration against the real app-shell registry. */

import {
  appShellPageMatchesPath,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
} from "@elizaos/ui";
import { describe, expect, it } from "vitest";

describe("Relationships app registration", () => {
  it("keeps graph imports passive and registers its lazy page once when requested", async () => {
    expect(typeof globalThis.document).toBe("undefined");
    expect(typeof globalThis.window).toBe("undefined");
    const initialVersion = getAppShellPageRegistrySnapshot();
    const { registerRelationshipsApp } = await import("./index.ts");
    expect(getAppShellPageRegistrySnapshot()).toBe(initialVersion);

    registerRelationshipsApp();
    const page = listAppShellPages().find(
      (entry) => entry.id === "relationships",
    );
    if (!page?.loader)
      throw new Error("Relationships page has no registered loader");
    expect(appShellPageMatchesPath(page, "/apps/relationships")).toBe(true);
    expect(appShellPageMatchesPath(page, "/character/relationships")).toBe(
      true,
    );
    expect(appShellPageMatchesPath(page, "/apps/unrelated")).toBe(false);
    expect(page.surface).toEqual({
      header: "fullscreen",
      capabilities: ["agent-surface"],
    });
    const loaded = await page.loader();
    expect(typeof loaded.default).toBe("function");
    const registeredVersion = getAppShellPageRegistrySnapshot();
    registerRelationshipsApp();
    expect(getAppShellPageRegistrySnapshot()).toBe(registeredVersion);
  });
});
