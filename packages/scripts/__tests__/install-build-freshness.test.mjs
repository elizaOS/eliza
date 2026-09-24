/**
 * Exercises install builds with real Turbo tasks and local cache restoration.
 * Source, shared build helpers and dependency changes must refresh consumers.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

for (const task of ["build", "@elizaos/app#build:dist", "@elizaos/ui#build"]) {
  test(`${task}: install refreshes stale distributions and restores cached outputs`, () => {
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
        "lib/repository-file-integrity.ts",
      ]) {
        const target = `packages/scripts/${name}`;
        write(target, readFileSync(path.join(root, target)));
      }
      const turbo = JSON.parse(
        readFileSync(path.join(root, "turbo.json"), "utf8"),
      );
      write(
        "turbo.json",
        JSON.stringify({
          tasks: {
            build: { ...turbo.tasks[task], dependsOn: ["^build"] },
            "build:package": { ...turbo.tasks[task], dependsOn: ["^build"] },
          },
        }),
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
      write("packages/scripts/prepare-package-dist.mjs", "manifest-v1");
      write("packages/scripts/copy-package-assets.mjs", "assets-v1");
      for (const name of ["leaf", "consumer"]) {
        write(
          `packages/${name}/package.json`,
          JSON.stringify({
            name,
            version: "1.0.0",
            type: "module",
            scripts:
              name === "consumer"
                ? { "build:package": "node build.mjs" }
                : { build: "node build.mjs" },
            dependencies: name === "consumer" ? { leaf: "workspace:*" } : {},
            elizaos: {
              scripts: {
                buildOnInstall:
                  name === "consumer" ? { script: "build:package" } : {},
              },
            },
          }),
        );
        write(`packages/${name}/src/index.ts`, name);
        write(`packages/${name}/runtime.json`, "runtime-v1");
        write(
          `packages/${name}/build.mjs`,
          `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.js', readFileSync('src/index.ts', 'utf8') + readFileSync('runtime.json', 'utf8') + readFileSync('../../plugins/plugin-build.ts', 'utf8') + readFileSync('../../plugins/plugin-build-externals.ts', 'utf8') + readFileSync('../scripts/prepare-package-dist.mjs', 'utf8') + readFileSync('../scripts/copy-package-assets.mjs', 'utf8')${name === "consumer" ? " + readFileSync('../leaf/dist/index.js', 'utf8')" : ""});`,
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
      write("packages/consumer/runtime.json", "runtime-v2");
      assert.match(run(), /runtime-v2/);
      write("packages/leaf/src/index.ts", "updated-leaf");
      assert.match(run(), /updated-leaf/);
      if (task === "build") {
        write("plugins/plugin-build.ts", "helper-v2");
        assert.match(run(), /helper-v2/);
        write("plugins/plugin-build-externals.ts", "externals-v2");
        assert.match(run(), /externals-v2/);
      }
      write("packages/scripts/prepare-package-dist.mjs", "manifest-v2");
      assert.match(run(), /manifest-v2/);
      write("packages/scripts/copy-package-assets.mjs", "assets-v2");
      const latest = run();
      assert.match(latest, /assets-v2/);
      rmSync(path.join(fixture, "packages/consumer/dist"), { recursive: true });
      assert.equal(run(), latest);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

for (const dependencyKind of ["dependencies", "peerDependencies"]) {
  test(`${dependencyKind}: source typechecks invalidate without building`, () => {
    const leaf =
      dependencyKind === "peerDependencies" ? "@elizaos/ui" : "@fixture/leaf";
    const consumer =
      dependencyKind === "peerDependencies"
        ? "@elizaos/plugin-todos"
        : "consumer";
    const fixture = mkdtempSync(path.join(tmpdir(), "eliza-typecheck-cache-"));
    const marker = `${fixture}.executions`;
    const write = (name, value) => {
      const target = path.join(fixture, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        typeof value === "string" ? value : JSON.stringify(value),
      );
    };
    try {
      const turbo = JSON.parse(
        readFileSync(path.join(root, "turbo.json"), "utf8"),
      );
      write("package.json", {
        name: "fixture",
        private: true,
        packageManager: "bun@1.3.14",
        workspaces: ["packages/*"],
      });
      write("turbo.json", {
        tasks: {
          typecheck: turbo.tasks.typecheck,
          "typecheck:deps": turbo.tasks["typecheck:deps"],
          build: turbo.tasks.build,
          ...(dependencyKind === "peerDependencies"
            ? {
                [`${consumer}#typecheck`]: turbo.tasks[`${consumer}#typecheck`],
              }
            : {}),
        },
      });
      write(".gitignore", "node_modules\n.turbo\n");
      write("packages/leaf/package.json", {
        name: leaf,
        version: "1.0.0",
        scripts: { build: "node fail-build.mjs" },
      });
      write(
        "packages/leaf/fail-build.mjs",
        'throw new Error("Source checking must not build dependencies");',
      );
      write("packages/leaf/src/index.ts", "export type Value = number;");
      write("packages/consumer/package.json", {
        name: consumer,
        version: "1.0.0",
        scripts: { typecheck: "node check.mjs" },
        [dependencyKind]: { [leaf]: "workspace:*" },
      });
      write("packages/consumer/tsconfig.json", {
        compilerOptions: {
          noEmit: true,
          strict: true,
          types: [],
          module: "ESNext",
          moduleResolution: "Bundler",
          paths: { [leaf]: ["../leaf/src/index.ts"] },
        },
        include: ["src"],
      });
      write(
        "packages/consumer/src/index.ts",
        `import type { Value } from "${leaf}"; export const value: Value = 42;`,
      );
      write(
        "packages/consumer/check.mjs",
        `import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
appendFileSync(${JSON.stringify(marker)}, "x");
const result = spawnSync(process.execPath, [${JSON.stringify(path.join(root, "node_modules/typescript/bin/tsc"))}, "--noEmit"], { stdio: "inherit" });
process.exit(result.status ?? 1);`,
      );
      const run = () =>
        spawnSync(
          process.execPath,
          [path.join(root, "node_modules/turbo/bin/turbo"), "run", "typecheck"],
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
      let result = run();
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(marker, "utf8"), "x");
      result = run();
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(marker, "utf8"), "x");
      write("packages/leaf/src/index.ts", "export type Value = string;");
      result = run();
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /not assignable to type/,
      );
      assert.equal(readFileSync(marker, "utf8"), "xx");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(marker, { force: true });
    }
  });
}
