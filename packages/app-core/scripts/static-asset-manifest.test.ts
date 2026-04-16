import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildStaticAssetManifest } from "./lib/static-asset-manifest.mjs";

const tempRoots: string[] = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "milady-static-asset-manifest-"),
  );
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("static asset manifest", () => {
  it("excludes hidden and system files from the manifest", () => {
    const root = makeTempRoot();
    const appPublic = path.join(root, "apps", "app", "public");
    const homepagePublic = path.join(root, "apps", "homepage", "public");

    fs.mkdirSync(path.join(appPublic, ".ignored-dir"), { recursive: true });
    fs.mkdirSync(homepagePublic, { recursive: true });
    fs.writeFileSync(path.join(appPublic, "logo.png"), "ok");
    fs.writeFileSync(path.join(appPublic, ".DS_Store"), "noise");
    fs.writeFileSync(path.join(appPublic, "Thumbs.db"), "noise");
    fs.writeFileSync(path.join(appPublic, ".ignored-dir", "secret.txt"), "nope");
    fs.writeFileSync(path.join(homepagePublic, "hero.png"), "ok");

    expect(buildStaticAssetManifest(root)).toEqual({
      app: ["apps/app/public/logo.png"],
      homepage: ["apps/homepage/public/hero.png"],
    });
  });
});
