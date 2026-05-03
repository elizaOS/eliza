import { describe, expect, it } from "vitest";
import {
  BACKEND_INSTALL_SPECS,
  buildInstallCommand,
  currentPlatform,
  type InstallMethod,
} from "../src/install.js";

describe("install spec — table coverage", () => {
  it("has a spec entry for each external backend", () => {
    expect(Object.keys(BACKEND_INSTALL_SPECS).sort()).toEqual([
      "1password",
      "bitwarden",
      "protonpass",
    ]);
  });

  it("provides at least one method per (backend, platform) pair", () => {
    const platforms = ["darwin", "linux", "win32"] as const;
    for (const id of Object.keys(BACKEND_INSTALL_SPECS) as Array<
      keyof typeof BACKEND_INSTALL_SPECS
    >) {
      const spec = BACKEND_INSTALL_SPECS[id];
      for (const p of platforms) {
        const methods = spec.methods[p];
        expect(methods, `${id}/${p}`).toBeDefined();
        expect(methods?.length, `${id}/${p}`).toBeGreaterThan(0);
      }
    }
  });

  it("1Password on darwin uses brew --cask 1password-cli", () => {
    const darwin = BACKEND_INSTALL_SPECS["1password"].methods.darwin;
    expect(darwin?.[0]).toEqual({
      kind: "brew",
      package: "1password-cli",
      cask: true,
    });
  });

  it("Bitwarden on darwin offers brew formula and npm fallback", () => {
    const darwin = BACKEND_INSTALL_SPECS.bitwarden.methods.darwin;
    expect(darwin?.[0]).toMatchObject({
      kind: "brew",
      package: "bitwarden-cli",
      cask: false,
    });
    expect(darwin?.some((m) => m.kind === "npm")).toBe(true);
  });

  it("Bitwarden on linux uses npm with the official @bitwarden/cli package", () => {
    const linux = BACKEND_INSTALL_SPECS.bitwarden.methods.linux;
    expect(linux?.[0]).toEqual({
      kind: "npm",
      package: "@bitwarden/cli",
    });
  });

  it("Proton Pass is manual everywhere (vendor CLI is in beta)", () => {
    for (const p of ["darwin", "linux", "win32"] as const) {
      const methods = BACKEND_INSTALL_SPECS.protonpass.methods[p];
      expect(methods?.every((m) => m.kind === "manual")).toBe(true);
      const manual = methods?.[0];
      if (manual && manual.kind === "manual") {
        expect(manual.url).toMatch(/^https:\/\/proton\.me\//);
      }
    }
  });
});

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
