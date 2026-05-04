import { describe, expect, it } from "vitest";
import { shouldBuildPluginForHost } from "../scripts/plugin-build.mjs";

describe("shouldBuildPluginForHost", () => {
  it("builds when no platforms are declared", () => {
    expect(shouldBuildPluginForHost({}, "win32")).toBe(true);
  });

  it("builds when platforms include runtime targets", () => {
    const pkg = { elizaos: { platforms: ["browser", "node"] } };
    expect(shouldBuildPluginForHost(pkg, "win32")).toBe(true);
  });

  it("skips pure OS allowlist plugins that exclude host", () => {
    const pkg = { elizaos: { platforms: ["darwin"] } };
    expect(shouldBuildPluginForHost(pkg, "win32")).toBe(false);
  });

  it("builds pure OS allowlist plugins when host matches", () => {
    const pkg = { elizaos: { platforms: ["win32"] } };
    expect(shouldBuildPluginForHost(pkg, "win32")).toBe(true);
  });

  it("skips Capacitor mobile plugins (peer dep heuristic) on all desktop hosts", () => {
    const pkg = { peerDependencies: { "@capacitor/core": "^8.0.0" } };
    expect(shouldBuildPluginForHost(pkg, "win32")).toBe(false);
    expect(shouldBuildPluginForHost(pkg, "darwin")).toBe(false);
    expect(shouldBuildPluginForHost(pkg, "linux")).toBe(false);
  });

  it("explicit platforms metadata takes precedence over Capacitor heuristic", () => {
    const pkg = {
      peerDependencies: { "@capacitor/core": "^8.0.0" },
      elizaos: { platforms: ["darwin"] },
    };
    expect(shouldBuildPluginForHost(pkg, "darwin")).toBe(true);
    expect(shouldBuildPluginForHost(pkg, "win32")).toBe(false);
  });
});
