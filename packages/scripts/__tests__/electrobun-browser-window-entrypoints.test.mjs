import path from "node:path";
import { describe, expect, it } from "vitest";
import { findElectrobunBrowserWindowEntrypoints } from "../lib/electrobun-browser-window-entrypoints.mjs";

describe("Electrobun BrowserWindow entrypoint discovery", () => {
  it("accepts the clean-install layout with only the shared dist source", () => {
    const packageRoot = path.join("node_modules", "electrobun");
    const sharedEntry = path.join(
      packageRoot,
      "dist",
      "api",
      "bun",
      "core",
      "BrowserWindow.ts",
    );

    expect(
      findElectrobunBrowserWindowEntrypoints(
        packageRoot,
        (candidate) => candidate === sharedEntry,
      ),
    ).toEqual([sharedEntry]);
  });

  it("returns every shipped entrypoint and fails discovery closed when none exist", () => {
    const packageRoot = path.join("node_modules", "electrobun");

    expect(
      findElectrobunBrowserWindowEntrypoints(packageRoot, () => true),
    ).toHaveLength(2);
    expect(
      findElectrobunBrowserWindowEntrypoints(packageRoot, () => false),
    ).toEqual([]);
  });
});
