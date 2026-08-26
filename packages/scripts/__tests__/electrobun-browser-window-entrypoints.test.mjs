import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyElectrobunLinuxNativeArtifacts,
  findElectrobunBrowserWindowEntrypoints,
} from "../lib/electrobun-browser-window-entrypoints.mjs";

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

describe("Electrobun Linux native artifact discovery", () => {
  it("distinguishes absent, partial, and complete native materialization", () => {
    const packageRoot = path.join("node_modules", "electrobun");

    expect(
      classifyElectrobunLinuxNativeArtifacts(packageRoot, () => false).state,
    ).toBe("absent");
    expect(
      classifyElectrobunLinuxNativeArtifacts(packageRoot, (candidate) =>
        candidate.endsWith("libNativeWrapper_cef.so"),
      ).state,
    ).toBe("incomplete");
    expect(
      classifyElectrobunLinuxNativeArtifacts(packageRoot, () => true).state,
    ).toBe("complete");
  });
});
