/**
 * Exercises the private white-label seam with placeholder assets: the brand
 * directory lives outside the repository, identity and signing stay canonical,
 * and the real mobile build context resolves the brand into its own app tree.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { loadWhitelabelBrandFromDir } from "./whitelabel.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
// 1x1 transparent PNG; real brands supply full-resolution artwork.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const directories: string[] = [];

function brandDir(manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-whitelabel-"));
  directories.push(dir);
  for (const name of ["icon.png", "splash.png", "mark.png", "boot.png"]) {
    fs.writeFileSync(path.join(dir, name), PLACEHOLDER_PNG);
  }
  fs.writeFileSync(path.join(dir, "brand.json"), JSON.stringify(manifest));
  return dir;
}

const VALID = {
  schemaVersion: 1,
  appName: "Placeholder",
  iconBackgroundColor: "#123456",
  icon: "icon.png",
  splash: "splash.png",
  splashMark: "mark.png",
  bootanimation: { logo: "boot.png", background: "#000000" },
};

afterEach(() => {
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("white-label brand loading", () => {
  it("resolves every asset inside the private directory", () => {
    const dir = brandDir(VALID);
    const brand = loadWhitelabelBrandFromDir(dir, repoRoot);
    const real = fs.realpathSync(dir);
    expect(brand).toEqual({
      dir: real,
      appName: "Placeholder",
      iconBackgroundColor: "#123456",
      icon: path.join(real, "icon.png"),
      splash: path.join(real, "splash.png"),
      splashMark: path.join(real, "mark.png"),
      bootanimation: {
        logo: path.join(real, "boot.png"),
        background: "#000000",
      },
    });
  });

  it.each([
    ["package id", { appId: "com.acme.alpha" }],
    ["signing", { keystorePath: "/secret/release.jks" }],
    ["url scheme", { urlScheme: "acme" }],
  ])("rejects %s changes", (_label, extra) => {
    const dir = brandDir({ ...VALID, ...extra });
    expect(() => loadWhitelabelBrandFromDir(dir, repoRoot)).toThrow(
      /unsupported field/,
    );
  });

  it("rejects assets outside the brand directory and missing splash art", () => {
    expect(() =>
      loadWhitelabelBrandFromDir(
        brandDir({ ...VALID, icon: "../icon.png" }),
        repoRoot,
      ),
    ).toThrow(/inside the brand directory/);
    const { splash: _splash, ...withoutSplash } = VALID;
    expect(() =>
      loadWhitelabelBrandFromDir(brandDir(withoutSplash), repoRoot),
    ).toThrow(/splash/);
  });

  it("refuses a brand directory inside the repository", () => {
    expect(() =>
      loadWhitelabelBrandFromDir(path.join(repoRoot, "packages"), repoRoot),
    ).toThrow(/outside the repository/);
  });
});

describe("mobile build context with a white-label brand", () => {
  it("keeps the canonical package id and builds outside the shared tree", () => {
    const dir = brandDir(VALID);
    const contextUrl = pathToFileURL(path.join(here, "context.ts")).href;
    const assetsUrl = pathToFileURL(path.join(here, "assets.ts")).href;
    const script = `
      const context = await import(${JSON.stringify(contextUrl)});
      const assets = await import(${JSON.stringify(assetsUrl)});
      process.stdout.write(JSON.stringify({
        app: context.APP,
        androidDir: context.androidDir,
        sharedAndroidDir: context.platformsDir + "/android",
        appDir: context.appDir,
        sources: assets.resolveBrandSources(),
      }));
    `;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELIZA_WHITELABEL_DIR: dir,
    };
    for (const name of [
      "ELIZA_APP_NAME",
      "ELIZA_APP_ID",
      "ELIZA_IOS_APP_ID",
      "ELIZA_ICON_BACKGROUND",
      "ELIZA_ANDROID_USE_APP_DIR",
    ]) {
      delete env[name];
    }
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: repoRoot, env, encoding: "utf8", timeout: 120_000 },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const resolved = JSON.parse(result.stdout);
    const real = fs.realpathSync(dir);
    expect(resolved.app.appName).toBe("Placeholder");
    expect(resolved.app.appId).toBe("ai.elizaos.app");
    expect(resolved.app.iconBackgroundColor).toBe("#123456");
    expect(resolved.androidDir).toBe(path.join(resolved.appDir, "android"));
    expect(resolved.androidDir).not.toBe(resolved.sharedAndroidDir);
    expect(resolved.sources).toEqual({
      iconSource: path.join(real, "icon.png"),
      launchSource: path.join(real, "splash.png"),
    });
  });
});
