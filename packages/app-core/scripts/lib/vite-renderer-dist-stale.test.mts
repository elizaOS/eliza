/**
 * Verifies renderer reuse against the real build manifest so UI-smoke cannot
 * cross the Playwright test-auth build boundary in either direction.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RENDERER_BUILD_MANIFEST_FILENAME,
  writeRendererBuildManifest,
} from "./renderer-build-manifest.mjs";
import { resolveElizaWorkspaceRootFromImportMeta } from "./repo-root.mjs";
import {
  rendererDistMatchesPlaywrightTestAuth,
  viteRendererBuildNeeded,
} from "./vite-renderer-dist-stale.mjs";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-auth-variant-"));
});

afterEach(() => {
  execFileSync(process.execPath, [cleanupHelperScript, tmp], {
    cwd: repoRoot,
    stdio: "inherit",
  });
});

function makeRenderer(playwrightTestAuth?: boolean) {
  const appDir = path.join(tmp, "app");
  const distDir = path.join(appDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<div id=root></div>");
  writeRendererBuildManifest(distDir, { playwrightTestAuth });
  return { appDir, distDir };
}

describe("Playwright test-auth renderer reuse", () => {
  it.each([true, false])(
    "reuses a fresh renderer when test auth is %s in both build and invocation",
    (playwrightTestAuth) => {
      const { appDir } = makeRenderer(playwrightTestAuth);

      expect(
        rendererDistMatchesPlaywrightTestAuth(appDir, playwrightTestAuth),
      ).toBe(true);
      expect(
        viteRendererBuildNeeded(appDir, tmp, {
          expectedPlaywrightTestAuth: playwrightTestAuth,
        }),
      ).toBe(false);
    },
  );

  it.each([
    { built: false, requested: true },
    { built: true, requested: false },
  ])(
    "rebuilds when a $built build is reused by a $requested invocation",
    ({ built, requested }) => {
      const { appDir } = makeRenderer(built);

      expect(rendererDistMatchesPlaywrightTestAuth(appDir, requested)).toBe(
        false,
      );
      expect(
        viteRendererBuildNeeded(appDir, tmp, {
          expectedPlaywrightTestAuth: requested,
        }),
      ).toBe(true);
    },
  );

  it.each(["legacy", "absent", "malformed", "partial"])(
    "fails closed when test-auth manifest metadata is %s",
    (manifestState) => {
      const { appDir, distDir } = makeRenderer();
      const manifestPath = path.join(distDir, RENDERER_BUILD_MANIFEST_FILENAME);
      if (manifestState === "legacy") {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        delete manifest.playwrightTestAuth;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      } else if (manifestState === "absent") {
        fs.unlinkSync(manifestPath);
      } else if (manifestState === "partial") {
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({ playwrightTestAuth: false }),
        );
      } else {
        fs.writeFileSync(manifestPath, "{not-json");
      }

      expect(rendererDistMatchesPlaywrightTestAuth(appDir, false)).toBe(false);
      expect(
        viteRendererBuildNeeded(appDir, tmp, {
          expectedPlaywrightTestAuth: false,
        }),
      ).toBe(true);
    },
  );

  it("treats a normal invocation as test auth disabled", () => {
    const previousPlaywrightTestAuth = process.env.VITE_PLAYWRIGHT_TEST_AUTH;
    delete process.env.VITE_PLAYWRIGHT_TEST_AUTH;
    try {
      const { appDir } = makeRenderer(false);

      expect(viteRendererBuildNeeded(appDir, tmp)).toBe(false);

      makeRenderer(true);
      expect(viteRendererBuildNeeded(appDir, tmp)).toBe(true);
    } finally {
      if (previousPlaywrightTestAuth === undefined) {
        delete process.env.VITE_PLAYWRIGHT_TEST_AUTH;
      } else {
        process.env.VITE_PLAYWRIGHT_TEST_AUTH = previousPlaywrightTestAuth;
      }
    }
  });
});
