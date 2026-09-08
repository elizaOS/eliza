/**
 * Regression tests for the repo-root derivation in the lifeops scripts that
 * default their file paths to this checkout. Each module is copied into a
 * temporary checkout whose path contains a space and imported from there, so
 * the test observes the real ROOT the module computes; a root derived from the
 * percent-encoded URL pathname would leak `%20` into every derived path
 * (#29569). Real filesystem, no mocks.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

async function importFromSpacedCheckout(moduleName, run) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "lifeops-root-")));
  try {
    const repo = join(base, "sp ace", "repo");
    const scripts = join(repo, "scripts", "lifeops");
    mkdirSync(scripts, { recursive: true });
    cpSync(join(HERE, moduleName), join(scripts, moduleName));
    const mod = await import(pathToFileURL(join(scripts, moduleName)).href);
    await run(mod, repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("hitl-ledger derives LEDGER_PATH from the decoded checkout path", async () => {
  await importFromSpacedCheckout("hitl-ledger.mjs", (mod, repo) => {
    assert.equal(
      mod.LEDGER_PATH,
      join(repo, "docs", "testing", "hitl-ledger.json"),
    );
    assert.ok(
      !mod.LEDGER_PATH.includes("%20"),
      `LEDGER_PATH leaked an encoded space: ${mod.LEDGER_PATH}`,
    );
  });
});

test("env-layers derives the default repo .env layer from the decoded checkout path", async () => {
  await importFromSpacedCheckout("env-layers.mjs", (mod, repo) => {
    const { layers } = mod.loadLayeredEnv({
      processEnv: {},
      homeEnvPath: join(repo, "home", ".env"),
    });
    const repoLayer = layers.find((layer) => layer.source === "repo");
    assert.ok(repoLayer, "loadLayeredEnv must report a repo layer");
    assert.equal(repoLayer.path, join(repo, ".env"));
    assert.ok(
      !repoLayer.path.includes("%20"),
      `repo layer leaked an encoded space: ${repoLayer.path}`,
    );
  });
});
