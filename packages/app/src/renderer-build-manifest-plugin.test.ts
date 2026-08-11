/**
 * Proves the renderer manifest records the same Playwright test-auth value
 * that Vite loads from env files and compiles into the browser bundle.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRendererBuildManifest } from "../../app-core/scripts/lib/renderer-build-manifest.mjs";
import { rendererBuildManifestPlugin } from "../vite/renderer-build-manifest-plugin.ts";

const cleanupHelperScript = path.resolve(
  import.meta.dirname,
  "../../scripts/rm-path-recursive.mjs",
);

let tmp: string;
let previousPlaywrightTestAuth: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-manifest-plugin-"));
  previousPlaywrightTestAuth = process.env.VITE_PLAYWRIGHT_TEST_AUTH;
  delete process.env.VITE_PLAYWRIGHT_TEST_AUTH;
});

afterEach(() => {
  if (previousPlaywrightTestAuth === undefined) {
    delete process.env.VITE_PLAYWRIGHT_TEST_AUTH;
  } else {
    process.env.VITE_PLAYWRIGHT_TEST_AUTH = previousPlaywrightTestAuth;
  }
  execFileSync(process.execPath, [cleanupHelperScript, tmp], {
    stdio: "inherit",
  });
});

describe("rendererBuildManifestPlugin", () => {
  it("records test auth loaded by Vite from an env file", async () => {
    const outDir = path.join(tmp, "dist");
    fs.writeFileSync(
      path.join(tmp, "index.html"),
      '<script type="module" src="/main.js"></script>',
    );
    fs.writeFileSync(
      path.join(tmp, "main.js"),
      "globalThis.testAuth = import.meta.env.VITE_PLAYWRIGHT_TEST_AUTH;",
    );
    fs.writeFileSync(
      path.join(tmp, ".env.production"),
      "VITE_PLAYWRIGHT_TEST_AUTH=true\n",
    );

    await build({
      root: tmp,
      configFile: false,
      logLevel: "silent",
      plugins: [rendererBuildManifestPlugin()],
      build: { outDir, minify: false },
    });

    const bundleSource = fs
      .readdirSync(path.join(outDir, "assets"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => fs.readFileSync(path.join(outDir, "assets", name), "utf8"))
      .join("\n");
    expect(bundleSource).toMatch(/globalThis\.testAuth\s*=\s*["']true["']/);
    expect(readRendererBuildManifest(outDir)?.playwrightTestAuth).toBe(true);
  });
});
