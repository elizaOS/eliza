/**
 * Exercises the shipped plugin-index CLI in an isolated installation layout.
 * Real catalog data is used; network access is rejected and write failures must
 * propagate as a nonzero process status instead of fabricating success.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
function runGenerator(blockOutput) {
  const root = mkdtempSync(path.join(tmpdir(), "first-party-index-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    symlinkSync(
      path.resolve(here, "../../../node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    copyFileSync(
      path.join(here, "generate-plugin-index.ts"),
      path.join(root, "scripts/generate-plugin-index.ts"),
    );
    writeFileSync(
      path.join(root, "no-network.mjs"),
      'globalThis.fetch = () => { throw new Error("Network access is forbidden"); };',
    );
    if (blockOutput) mkdirSync(path.join(root, "plugins.json"));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(root, "no-network.mjs"),
        path.join(root, "scripts/generate-plugin-index.ts"),
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    return {
      result,
      manifest:
        result.status === 0
          ? JSON.parse(readFileSync(path.join(root, "plugins.json"), "utf8"))
          : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("generates a first-party manifest offline from an empty installation", () => {
  const { result, manifest } = runGenerator(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(manifest.count, manifest.plugins.length);
  const openai = manifest.plugins.find((plugin) => plugin.id === "openai");
  assert.equal(openai.npmName, "@elizaos/plugin-openai");
  assert.equal(openai.category, "ai-provider");
  assert.ok(openai.configKeys.includes("OPENAI_API_KEY"));
  assert.equal(openai.pluginParameters.OPENAI_API_KEY.sensitive, true);
  assert.ok(
    manifest.plugins.some(
      (plugin) => plugin.id === "discord" && plugin.category === "connector",
    ),
  );
  assert.ok(
    manifest.plugins.every(
      (plugin) => !plugin.npmName || plugin.npmName.startsWith("@elizaos/"),
    ),
  );
});

test("fails rather than reporting success when the output cannot be written", () => {
  const { result, manifest } = runGenerator(true);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EISDIR/);
  assert.equal(manifest, null);
});
