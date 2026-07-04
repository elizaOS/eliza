/**
 * Unit coverage for resolving the main-tab app from the registry. Pure functions,
 * no runtime.
 */
import type { RegistryAppInfo } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { getMainTabApp } from "./main-tab";

/**
 * Main-tab discovery. An app claims the shell's default landing tab by setting
 * `elizaos.app.mainTab=true`; `getMainTabApp` picks the unique declarer (or the
 * alphabetically-first when several misconfigure it) and maps its package name
 * to a route slug. Untested, so a regression in the declarer filter, the
 * deterministic tie-break, or the name→slug mapping would silently change where
 * the shell lands. Pure (the sort runs on a filtered copy, never the input).
 */

// getMainTabApp only reads `name` + `mainTab`; cast a minimal record.
const appInfo = (name: string, mainTab?: boolean | string): RegistryAppInfo =>
  ({ name, mainTab }) as unknown as RegistryAppInfo;

describe("getMainTabApp", () => {
  it("returns null when no app declares mainTab", () => {
    expect(getMainTabApp([])).toBeNull();
    expect(getMainTabApp([appInfo("@elizaos/app-feed", false)])).toBeNull();
    // a non-boolean mainTab is ignored defensively.
    expect(getMainTabApp([appInfo("@elizaos/app-feed", "true")])).toBeNull();
  });

  it("maps the declarer's package name to a route slug", () => {
    expect(getMainTabApp([appInfo("@elizaos/app-feed", true)])).toEqual({
      tabId: "feed",
      appName: "@elizaos/app-feed",
    });
  });

  it("breaks ties deterministically by package name", () => {
    const apps = [
      appInfo("@elizaos/app-zebra", true),
      appInfo("@elizaos/app-alpha", true),
    ];
    expect(getMainTabApp(apps)).toEqual({
      tabId: "alpha",
      appName: "@elizaos/app-alpha",
    });
  });

  it("does not mutate the input array order", () => {
    const apps = [
      appInfo("@elizaos/app-zebra", true),
      appInfo("@elizaos/app-alpha", true),
    ];
    getMainTabApp(apps);
    expect(apps.map((a) => a.name)).toEqual([
      "@elizaos/app-zebra",
      "@elizaos/app-alpha",
    ]);
  });
});
