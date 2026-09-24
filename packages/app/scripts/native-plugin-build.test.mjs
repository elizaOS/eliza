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
      "build-native-plugins.mjs",
      "plugin-build.mjs",
      "lib/capacitor-plugin-names.mjs",
    ]) {
      const target = path.join(appScripts, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(scripts, file), target);
    }
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
          scripts: { build: "node build.mjs" },
          dependencies:
            name === "plugin" ? { "@elizaos/core": "workspace:*" } : {},
        }),
      );
      fs.writeFileSync(
        path.join(directory, "build.mjs"),
        `
        import fs from 'node:fs';
        fs.appendFileSync(${JSON.stringify(events)}, ${JSON.stringify(`${name}\n`)});
        fs.mkdirSync('dist', { recursive: true });
        fs.writeFileSync('dist/index.js', 'export {};');
      `,
      );
    }
    const run = (entry, extraEnv = {}) =>
      spawnSync(process.execPath, [path.join(appScripts, entry)], {
        cwd: root,
        env: {
          ...process.env,
          CI: "false",
          SKIP_NATIVE_PLUGINS: "0",
          ELIZA_FORCE_PLUGIN_BUILD: "0",
          ELIZA_DEV_SOURCE: "0",
          ...extraEnv,
        },
        encoding: "utf8",
      });
    const success = (result) => assert.equal(result.status, 0, result.stderr);
    const history = () => fs.readFileSync(events, "utf8").trim().split("\n");
    success(run("build-native-plugins.mjs"));
    assert.deepEqual(history(), ["core", "plugin"]);
    success(run("build-native-plugins.mjs"));
    assert.deepEqual(history(), ["core", "plugin"]);
    success(run("plugin-build.mjs", { ELIZA_DEV_SOURCE: "1" }));
    assert.deepEqual(history(), ["core", "plugin", "plugin"]);
    success(run("plugin-build.mjs"));
    assert.deepEqual(history(), ["core", "plugin", "plugin", "core", "plugin"]);
    const pluginManifestPath = path.join(plugin, "package.json");
    const manifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
    manifest.eliza = {
      platforms: [process.platform === "win32" ? "linux" : "win32"],
    };
    fs.writeFileSync(pluginManifestPath, JSON.stringify(manifest));
    success(run("plugin-build.mjs"));
    assert.deepEqual(history(), ["core", "plugin", "plugin", "core", "plugin"]);
    delete manifest.eliza;
    fs.writeFileSync(pluginManifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(core, "build.mjs"), "process.exit(7);\n");
    const failure = run("plugin-build.mjs");
    assert.notEqual(failure.status, 0);
    assert.deepEqual(history(), ["core", "plugin", "plugin", "core", "plugin"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
