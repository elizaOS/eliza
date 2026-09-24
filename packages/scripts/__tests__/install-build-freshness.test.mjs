/**
 * Exercises install builds with real Turbo tasks and local cache restoration.
 * Source, shared build helpers and dependency changes must refresh consumers.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  realpathSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("install refreshes stale distributions and restores cached outputs", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "eliza-install-build-"));
  const write = (name, value) => {
    const target = path.join(fixture, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  try {
    for (const name of [
      "build-private-workspace-packages.mjs",
      "run-turbo.mjs",
      "lib/script-metadata.ts",
      "lib/workspaces.ts",
      "lib/repository-file-integrity.mjs",
    ]) {
      const target = `packages/scripts/${name}`;
      write(target, readFileSync(path.join(root, target)));
    }
    const turbo = JSON.parse(
      readFileSync(path.join(root, "turbo.json"), "utf8"),
    );
    write(
      "turbo.json",
      JSON.stringify({ tasks: { build: turbo.tasks.build } }),
    );
    write(
      "package.json",
      JSON.stringify({
        name: "fixture",
        private: true,
        packageManager: "bun@1.3.14",
        workspaces: ["packages/leaf", "packages/consumer"],
      }),
    );
    write(".gitignore", "node_modules\n.turbo\ndist\n");
    write("plugins/plugin-build.ts", "helper-v1");
    write("plugins/plugin-build-externals.ts", "externals-v1");
    for (const name of ["leaf", "consumer"]) {
      write(
        `packages/${name}/package.json`,
        JSON.stringify({
          name,
          version: "1.0.0",
          type: "module",
          scripts: { build: "node build.mjs" },
          dependencies: name === "consumer" ? { leaf: "workspace:*" } : {},
          elizaos: {
            scripts: {
              buildOnInstall: {
                sentinel: "dist/index.js",
                order: name === "consumer" ? 0 : 1,
              },
            },
          },
        }),
      );
      write(`packages/${name}/src/index.ts`, name);
      write(
        `packages/${name}/build.mjs`,
        `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.js', readFileSync('src/index.ts', 'utf8') + readFileSync('../../plugins/plugin-build.ts', 'utf8') + readFileSync('../../plugins/plugin-build-externals.ts', 'utf8')${name === "consumer" ? " + readFileSync('../leaf/dist/index.js', 'utf8')" : ""});`,
      );
    }
    // The real runner resolves Turbo from node_modules without installing fixtures.
    mkdirSync(path.join(fixture, "node_modules"), { recursive: true });
    symlinkSync(
      realpathSync(path.join(root, "node_modules/turbo")),
      path.join(fixture, "node_modules/turbo"),
      "junction",
    );
    const run = () => {
      const result = spawnSync(
        process.execPath,
        ["packages/scripts/build-private-workspace-packages.mjs"],
        {
          cwd: fixture,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            TURBO_TELEMETRY_DISABLED: "1",
            TURBO_CACHE: "local:rw",
          },
        },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return readFileSync(
        path.join(fixture, "packages/consumer/dist/index.js"),
        "utf8",
      );
    };
    const first = run();
    assert.equal(run(), first);
    write("packages/leaf/src/index.ts", "updated-leaf");
    assert.match(run(), /updated-leaf/);
    write("plugins/plugin-build.ts", "helper-v2");
    assert.match(run(), /helper-v2/);
    write("plugins/plugin-build-externals.ts", "externals-v2");
    const latest = run();
    assert.match(latest, /externals-v2/);
    rmSync(path.join(fixture, "packages/consumer/dist"), { recursive: true });
    assert.equal(run(), latest);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
