import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildOutputCleanTargets, removeBuildOutputs } from "./clean-repo.ts";

describe("clean-repo build outputs", () => {
  test("every target has a label and an absolute path under the root", () => {
    const root = path.join(os.tmpdir(), "clean-repo-root");
    for (const [label, abs] of buildOutputCleanTargets(root)) {
      expect(label.length).toBeGreaterThan(0);
      expect(path.isAbsolute(abs)).toBe(true);
      expect(abs.startsWith(root + path.sep)).toBe(true);
    }
  });

  test("removes homepage dist and .vite directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clean-repo-"));
    try {
      const homepageDist = path.join(root, "packages", "homepage", "dist");
      const homepageVite = path.join(root, "packages", "homepage", ".vite");
      const appDist = path.join(root, "packages", "app", "dist");
      for (const dir of [homepageDist, homepageVite, appDist]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "artifact.txt"), "x");
      }
      removeBuildOutputs(root);
      expect(fs.existsSync(homepageDist)).toBe(false);
      expect(fs.existsSync(homepageVite)).toBe(false);
      expect(fs.existsSync(appDist)).toBe(false);
      expect(fs.existsSync(path.join(root, "packages", "homepage"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
