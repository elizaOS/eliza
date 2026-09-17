/** Verifies the assembled diagnostic payload with real helper files and Node. */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { copyPublishAssets } from "./copy-publish-assets.mjs";

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
    await copyPublishAssets({
      sourceRoot: repositoryRoot,
      destinationPackage: fixture,
    });
    const dist = path.join(fixture, "dist");
    writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({
        private: true,
        workspaces: ["apps/*"],
      }),
    );
    for (const name of ["app", "lib"]) {
      mkdirSync(path.join(fixture, "apps", name), { recursive: true });
      writeFileSync(
        path.join(fixture, "apps", name, "package.json"),
        JSON.stringify({
          name: `@fixture/${name}`,
          version: "1.0.0",
        }),
      );
    }
    const appManifest = path.join(fixture, "apps/app/package.json");
    const workspaceCheck = path.join(dist, "scripts/fix-workspace-deps.mjs");
    execFileSync(process.execPath, [workspaceCheck, "--check"], {
      cwd: fixture,
      stdio: "pipe",
    });
    const invalidManifest = JSON.stringify({
      name: "@fixture/app",
      version: "1.0.0",
      dependencies: { "@fixture/lib": "^1.0.0" },
    });
    writeFileSync(appManifest, invalidManifest);
    const invalidCheck = spawnSync(
      process.execPath,
      [workspaceCheck, "--check"],
      { cwd: fixture, encoding: "utf8" },
    );
    expect(invalidCheck.status).toBe(1);
    expect(invalidCheck.stdout + invalidCheck.stderr).toContain("@fixture/lib");
    expect(readFileSync(appManifest, "utf8")).toBe(invalidManifest);
    expect(
      readFileSync(
        path.join(dist, "scripts/lib/ios-app-store-runtime-policy.mjs"),
      ),
    ).toEqual(
      readFileSync(
        path.join(
          repositoryRoot,
          "packages/native/bun-runtime/scripts/ios-app-store-runtime-policy.mjs",
        ),
      ),
    );
    // Bundle outside the checkout: relative imports must resolve entirely from
    // the assembled payload. Bare packages remain normal consumer dependencies.
    execFileSync(
      "bun",
      [
        "build",
        ...[
          "dev-ui",
          "run-mobile-build",
          "desktop-build",
          "dev-platform",
          "build-electrobun-preload",
        ].map((entry) => path.join(dist, `scripts/${entry}.mjs`)),
        "--packages=external",
        "--target=node",
        `--outdir=${path.join(fixture, "bundled")}`,
      ],
      { cwd: fixture, stdio: "pipe" },
    );
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
