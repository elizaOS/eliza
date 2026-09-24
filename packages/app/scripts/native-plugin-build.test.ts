/** Exercises both native build entrypoints against real temporary packages and build subprocesses. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));

test("shared builder preserves freshness, forced development builds, and dependency failures", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "native-build-contract-")),
  );
  const appScripts = path.join(root, "packages/app/scripts");
  const plugin = path.join(root, "plugins/plugin-native-fixture");
  const core = path.join(root, "packages/core");
  const events = path.join(root, "events");
  try {
    for (const file of [
      "build-native-plugins.ts",
      "plugin-build.ts",
      "lib/capacitor-plugin-names.ts",
    ]) {
      const target = path.join(appScripts, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(scripts, file), target);
    }
    const repoRoot = path.resolve(scripts, "../../..");
    const runner = path.join(root, "packages/scripts/run-turbo.ts");
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "packages/scripts/run-turbo.ts"),
      runner,
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "native-build-fixture",
        type: "module",
        private: true,
        packageManager: JSON.parse(
          fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
        ).packageManager,
        workspaces: ["packages/core", "plugins/*"],
      }),
    );
    fs.writeFileSync(
      path.join(root, ".gitignore"),
      "node_modules\n.turbo\ndist\n",
    );
    fs.writeFileSync(
      path.join(root, "turbo.json"),
      JSON.stringify({
        tasks: {
          build: {
            dependsOn: ["^build"],
            outputs: ["dist/**"],
            inputs: ["$TURBO_DEFAULT$", "!dist/**"],
          },
        },
      }),
    );
    for (const [directory, name] of [
      [core, "core"],
      [plugin, "plugin"],
    ]) {
      fs.mkdirSync(path.join(directory, "src"), { recursive: true });
      fs.writeFileSync(path.join(directory, "src/index.ts"), "export {};\n");
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({
          name: name === "core" ? "@elizaos/core" : "@fixture/native",
          version: "1.0.0",
          scripts: { build: "node build.ts" },
          dependencies:
            name === "plugin" ? { "@elizaos/core": "workspace:*" } : {},
        }),
      );
      fs.writeFileSync(
        path.join(directory, "build.ts"),
        `
        import fs from 'node:fs';
        fs.appendFileSync(${JSON.stringify(events)}, ${JSON.stringify(`${name}\n`)});
        fs.mkdirSync('dist', { recursive: true });
        fs.writeFileSync('dist/index.js', 'export {};');
      `,
      );
    }
    assert.equal(
      spawnSync("git", ["init", "--quiet"], { cwd: root }).status,
      0,
    );
    // Match the repository's supported v1 lockfile rather than generating a
    // newer format that the pinned Turbo cannot hash. Frozen install verifies it.
    fs.writeFileSync(
      path.join(root, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 1,
        configVersion: 1,
        workspaces: {
          "": { name: "native-build-fixture" },
          "packages/core": { name: "@elizaos/core", version: "1.0.0" },
          "plugins/plugin-native-fixture": {
            name: "@fixture/native",
            version: "1.0.0",
            dependencies: { "@elizaos/core": "workspace:*" },
          },
        },
        packages: {
          "@elizaos/core": ["@elizaos/core@workspace:packages/core"],
          "@fixture/native": [
            "@fixture/native@workspace:plugins/plugin-native-fixture",
          ],
        },
      }),
    );
    const install = spawnSync(
      "bun",
      ["install", "--frozen-lockfile", "--ignore-scripts"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(install.status, 0, install.stderr);
    fs.symlinkSync(
      fs.realpathSync(path.join(repoRoot, "node_modules/turbo")),
      path.join(root, "node_modules/turbo"),
      "junction",
    );
    assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0);
    assert.equal(
      spawnSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--quiet",
          "-m",
          "Fixture",
        ],
        { cwd: root },
      ).status,
      0,
    );
    const run = (entry, extraEnv = {}) =>
      spawnSync(process.execPath, [path.join(appScripts, entry)], {
        cwd: root,
        env: {
          ...process.env,
          CI: "false",
          SKIP_NATIVE_PLUGINS: "0",
          ELIZA_FORCE_PLUGIN_BUILD: "0",
          ELIZA_DEV_SOURCE: "0",
          TURBO_FORCE: undefined,
          TURBO_CACHE: "local:rw",
          TURBO_TELEMETRY_DISABLED: "1",
          ...extraEnv,
        },
        encoding: "utf8",
      });
    const success = (result) =>
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const history = () => fs.readFileSync(events, "utf8").trim().split("\n");
    success(run("build-native-plugins.ts"));
    assert.deepEqual(history(), ["core", "plugin"]);
    success(run("build-native-plugins.ts"));
    assert.deepEqual(history(), ["core", "plugin"]);
    fs.rmSync(path.join(plugin, "dist"), { recursive: true });
    success(run("build-native-plugins.ts"));
    assert.ok(fs.existsSync(path.join(plugin, "dist/index.js")));
    assert.deepEqual(history(), ["core", "plugin"]);
    success(run("plugin-build.ts"));
    assert.deepEqual(history(), ["core", "plugin"]);
    success(
      run("plugin-build.ts", {
        ELIZA_DEV_SOURCE: "1",
        ELIZA_FORCE_PLUGIN_BUILD: "1",
      }),
    );
    assert.deepEqual(history(), ["core", "plugin", "plugin"]);
    success(run("plugin-build.ts", { ELIZA_FORCE_PLUGIN_BUILD: "1" }));
    assert.deepEqual(history(), ["core", "plugin", "plugin", "core", "plugin"]);
    const pluginManifestPath = path.join(plugin, "package.json");
    const manifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
    manifest.eliza = {
      platforms: [process.platform === "win32" ? "linux" : "win32"],
    };
    fs.writeFileSync(pluginManifestPath, JSON.stringify(manifest));
    success(run("plugin-build.ts"));
    assert.deepEqual(history(), ["core", "plugin", "plugin", "core", "plugin"]);
    delete manifest.eliza;
    fs.writeFileSync(pluginManifestPath, JSON.stringify(manifest));
    // Dependency contents must invalidate consumers even with older mtimes.
    const coreSource = path.join(core, "src/index.ts");
    fs.writeFileSync(coreSource, "export const changed = true;\n");
    fs.utimesSync(coreSource, new Date(0), new Date(0));
    success(run("build-native-plugins.ts"));
    const refreshed = [
      "core",
      "plugin",
      "plugin",
      "core",
      "plugin",
      "core",
      "plugin",
    ];
    assert.deepEqual(history(), refreshed);
    fs.writeFileSync(path.join(core, "build.ts"), "process.exit(7);\n");
    const failure = run("plugin-build.ts");
    assert.notEqual(failure.status, 0);
    assert.deepEqual(history(), refreshed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
