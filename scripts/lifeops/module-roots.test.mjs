/**
 * Exercises ledger persistence and credential-layer reads/writes from an isolated
 * checkout whose path needs URL decoding. Real filesystem operations prove that
 * operator state stays in the checkout, without accessing actual credentials.
 */
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

async function importFromSpacedCheckout(moduleName, run) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "lifeops-root-")));
  try {
    const repo = join(base, "sp ace-é#", "repo");
    const scripts = join(repo, "scripts", "lifeops");
    mkdirSync(scripts, { recursive: true });
    cpSync(join(HERE, moduleName), join(scripts, moduleName));
    const mod = await import(pathToFileURL(join(scripts, moduleName)).href);
    await run(mod, repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("ledger outcomes persist in the decoded checkout and survive a reread", async () => {
  await importFromSpacedCheckout("hitl-ledger.mjs", (mod, repo) => {
    const outcome = {
      pathId: "fixture-calendar",
      ok: true,
      at: "2026-09-10T10:00:00.000Z",
      lane: "fixture",
      commit: "fixture-commit",
      counts: { passed: 1, failed: 0, skipped: 0 },
    };
    mod.recordOutcome(outcome);
    const persisted = JSON.parse(
      readFileSync(join(repo, "docs", "testing", "hitl-ledger.json"), "utf8"),
    );
    assert.equal(persisted.entries[outcome.pathId].lastSuccessAt, outcome.at);
    mod.recordOutcome({
      ...outcome,
      ok: false,
      at: "2026-09-10T11:00:00.000Z",
      counts: { passed: 0, failed: 1, skipped: 0 },
    });
    const reread = mod.readLedger().entries[outcome.pathId];
    assert.equal(reread.lastSuccessAt, outcome.at);
    assert.equal(reread.counts.failed, 1);
  });
});

test("credential reads and writes use the decoded checkout's repo layer", async () => {
  await importFromSpacedCheckout("env-layers.mjs", (mod, repo) => {
    const envPath = join(repo, ".env");
    writeFileSync(
      envPath,
      "FIXTURE_CALENDAR_TOKEN=before\nFIXTURE_KEEP=retained\n",
    );
    const options = { processEnv: {}, homeEnvPath: join(repo, "home", ".env") };
    assert.equal(
      mod.loadLayeredEnv(options).values.FIXTURE_CALENDAR_TOKEN,
      "before",
    );
    mod.writeSecret("FIXTURE_CALENDAR_TOKEN", "after", {
      ...options,
      scope: "repo",
    });
    const disk = mod.parseDotenv(readFileSync(envPath, "utf8"));
    assert.equal(disk.FIXTURE_CALENDAR_TOKEN, "after");
    assert.equal(disk.FIXTURE_KEEP, "retained");
    const loaded = mod.loadLayeredEnv({ ...options, processEnv: {} });
    assert.equal(loaded.values.FIXTURE_CALENDAR_TOKEN, "after");
    assert.equal(loaded.sources.FIXTURE_CALENDAR_TOKEN, "repo");
  });
});
