/**
 * Pins the plugin-pty / @elizaos/shared published-package contract (#29490):
 * shared is a workspace runtime dependency and a Bun.build external, so a
 * clean checkout can bundle plugin-pty before packages/shared/dist exists.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { externalsFromPackageJson } from "../../plugin-build-externals.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_TS = path.join(PACKAGE_ROOT, "build.ts");
const PACKAGE_JSON = path.join(PACKAGE_ROOT, "package.json");
const ENTRY = path.join(PACKAGE_ROOT, "lib", "eliza-code-spec.ts");

function explicitBuildExternals(source: string): string[] {
  const match = source.match(/externals:\s*\[([^\]]+)\]/);
  if (!match) {
    throw new Error("plugin-pty/build.ts has no explicit externals array");
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

describe("plugin-pty shared build contract", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares @elizaos/shared as a workspace runtime dependency", async () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@elizaos/shared"]).toBe("workspace:*");
    const fromManifest = await externalsFromPackageJson(PACKAGE_JSON);
    expect(fromManifest).toContain("@elizaos/shared");
  });

  it("externalizes @elizaos/shared so the plugin bundle does not require shared dist", async () => {
    const externals = explicitBuildExternals(readFileSync(BUILD_TS, "utf8"));
    expect(externals).toEqual(
      expect.arrayContaining([
        "@elizaos/core",
        "@elizaos/shared",
        "@lydell/node-pty",
      ]),
    );

    const outdir = mkdtempSync(path.join(tmpdir(), "plugin-pty-shared-ext-"));
    tempDirs.push(outdir);
    const bunArgs = [
      "build",
      ENTRY,
      "--outdir",
      outdir,
      "--target",
      "node",
      "--format",
      "esm",
      ...externals.flatMap((name) => ["--external", name]),
    ];
    const built = spawnSync("bun", bunArgs, {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    });
    expect(built.status, built.stderr || built.stdout).toBe(0);
    const bundled = readFileSync(
      path.join(outdir, "eliza-code-spec.js"),
      "utf8",
    );
    expect(bundled).toMatch(/from\s*["']@elizaos\/shared["']/);
    expect(bundled).not.toMatch(/packages\/shared\/src/);
  });
});
