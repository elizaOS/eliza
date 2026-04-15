import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncPlatformTemplateFiles } from "./run-mobile-build.mjs";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-mobile-build-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("run-mobile-build", () => {
  it("syncs canonical ios and android platform template files", () => {
    const repoRoot = makeTempDir();
    const appDir = path.join(repoRoot, "apps", "app");

    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "ios",
        "App",
        "Podfile",
      ),
      "ios-podfile\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "android",
        "build.gradle",
      ),
      "android-root\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "android",
        "app",
        "capacitor.build.gradle",
      ),
      "android-capacitor\n",
    );

    const iosCopied = syncPlatformTemplateFiles("ios", {
      repoRootValue: repoRoot,
      appDirValue: appDir,
      log: () => {},
    });
    const androidCopied = syncPlatformTemplateFiles("android", {
      repoRootValue: repoRoot,
      appDirValue: appDir,
      log: () => {},
    });

    expect(iosCopied).toEqual([path.join("App", "Podfile")]);
    expect(androidCopied).toContain("build.gradle");
    expect(androidCopied).toContain(path.join("app", "capacitor.build.gradle"));
    expect(
      fs.readFileSync(path.join(appDir, "ios", "App", "Podfile"), "utf8"),
    ).toBe("ios-podfile\n");
    expect(
      fs.readFileSync(path.join(appDir, "android", "build.gradle"), "utf8"),
    ).toBe("android-root\n");
    expect(
      fs.readFileSync(
        path.join(appDir, "android", "app", "capacitor.build.gradle"),
        "utf8",
      ),
    ).toBe("android-capacitor\n");
  });

  it("keeps shipped platform templates on app-local capacitor packages", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
    const iosPodfile = fs.readFileSync(
      path.join(
        repoRoot,
        "packages",
        "app-core",
        "platforms",
        "ios",
        "App",
        "Podfile",
      ),
      "utf8",
    );
    const androidSettings = fs.readFileSync(
      path.join(
        repoRoot,
        "packages",
        "app-core",
        "platforms",
        "android",
        "capacitor.settings.gradle",
      ),
      "utf8",
    );
    const androidBuild = fs.readFileSync(
      path.join(
        repoRoot,
        "packages",
        "app-core",
        "platforms",
        "android",
        "app",
        "capacitor.build.gradle",
      ),
      "utf8",
    );

    expect(iosPodfile).not.toContain("node_modules/.bun/");
    expect(iosPodfile).toContain("../../node_modules/@capacitor/ios");
    expect(iosPodfile).not.toContain("CapacitorStatusBar");

    expect(androidSettings).not.toContain("node_modules/.bun/");
    expect(androidSettings).toContain(
      "../node_modules/@capacitor/android/capacitor",
    );
    expect(androidSettings).not.toContain("capacitor-status-bar");

    expect(androidBuild).not.toContain("capacitor-status-bar");
  });
});
