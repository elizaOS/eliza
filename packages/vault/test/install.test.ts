/**
 * Tests password-manager install metadata and generated install commands.
 */

import { describe, expect, it } from "vitest";
import {
  buildInstallCommand,
  currentPlatform,
  type InstallMethod,
} from "../src/install.js";

describe("buildInstallCommand", () => {
  it("brew formula: install <pkg>", () => {
    const out = buildInstallCommand({
      kind: "brew",
      package: "bitwarden-cli",
      cask: false,
    });
    expect(out).toEqual({
      command: "brew",
      args: ["install", "bitwarden-cli"],
    });
  });

  it("brew cask: install --cask <pkg>", () => {
    const out = buildInstallCommand({
      kind: "brew",
      package: "1password-cli",
      cask: true,
    });
    expect(out).toEqual({
      command: "brew",
      args: ["install", "--cask", "1password-cli"],
    });
  });

  it("npm: install -g <pkg>", () => {
    const out = buildInstallCommand({
      kind: "npm",
      package: "@bitwarden/cli",
    });
    expect(out).toEqual({
      command: "npm",
      args: ["install", "-g", "@bitwarden/cli"],
    });
  });

  it("manual: returns null (no automated path)", () => {
    const m: InstallMethod = {
      kind: "manual",
      instructions: "x",
      url: "https://example.com",
    };
    expect(buildInstallCommand(m)).toBeNull();
  });
});

describe("currentPlatform", () => {
  it("returns the host platform for darwin/linux/win32", () => {
    const p = currentPlatform();
    expect(["darwin", "linux", "win32"]).toContain(p);
  });
});
