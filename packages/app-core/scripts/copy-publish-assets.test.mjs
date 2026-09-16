/** Verifies the assembled diagnostic payload with real helper files and Node. */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { copyPackageAssets } from "../../scripts/copy-package-assets.mjs";
import { PUBLISH_ASSET_PATHS } from "./copy-publish-assets.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "../..");

it("ships diagnostic helper dependencies without the repository test harness", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "app-core-payload-"));
  try {
    for (const root of [
      "src/styles",
      "scripts",
      "platforms",
      "packaging",
      "patches",
      "test",
    ]) {
      mkdirSync(path.dirname(path.join(fixture, root)), { recursive: true });
      cpSync(path.join(packageRoot, root), path.join(fixture, root), {
        recursive: true,
      });
    }
    await copyPackageAssets({
      repositoryRoot,
      packageDirectory: fixture,
      assetPaths: PUBLISH_ASSET_PATHS,
    });
    const dist = path.join(fixture, "dist");
    expect(existsSync(path.join(dist, "test/scripts"))).toBe(false);
    expect(existsSync(path.join(dist, "test/helpers/action-spy.ts"))).toBe(
      false,
    );
    // Every shipped script's direct diagnostic helper and its local helper
    // dependencies must survive assembly, including extensionless TS imports.
    for (const directory of ["scripts", "test/helpers"]) {
      for (const entry of readdirSync(path.join(dist, directory), {
        recursive: true,
      })) {
        if (!/\.[cm]?[jt]s$/.test(entry)) continue;
        const file = path.join(dist, directory, entry);
        for (const match of readFileSync(file, "utf8").matchAll(
          /(?:from\s*|import\s*\()(["'])(\.[^"']+)\1/g,
        )) {
          const dependency = path.resolve(path.dirname(file), match[2]);
          if (
            !dependency.startsWith(path.join(dist, "test/helpers") + path.sep)
          )
            continue;
          expect(
            [dependency, `${dependency}.ts`, `${dependency}.mjs`].some(
              existsSync,
            ),
            `${file}: ${match[2]}`,
          ).toBe(true);
        }
      }
    }
    const helper = pathToFileURL(
      path.join(dist, "test/helpers/isolated-config.ts"),
    ).href;
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { existsSync } from "node:fs";
      import { dirname } from "node:path";
      import { useIsolatedConfigEnv } from ${JSON.stringify(helper)};
      process.env.ELIZA_CONFIG_PATH = "original";
      const config = useIsolatedConfigEnv("published-config-");
      assert.equal(process.env.ELIZA_CONFIG_PATH, config.configPath);
      assert.ok(existsSync(dirname(config.configPath)));
      await config.restore();
      assert.equal(process.env.ELIZA_CONFIG_PATH, "original");
      assert.equal(existsSync(dirname(config.configPath)), false);
    `,
      ],
      { cwd: fixture, stdio: "pipe" },
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
