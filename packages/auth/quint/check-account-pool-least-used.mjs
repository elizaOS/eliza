/** Exercises least-used stamp ownership through the default encrypted account pool. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.versions.bun) {
  const run = spawnSync(
    "bun",
    ["--conditions=eliza-source", fileURLToPath(import.meta.url)],
    { stdio: "inherit", timeout: 120_000 },
  );
  if (run.error) throw run.error;
  if (run.signal) process.kill(process.pid, run.signal);
  process.exit(run.status ?? 1);
}

process.env.NODE_ENV = "test";
process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = "1";
process.env.ELIZA_VAULT_PASSPHRASE = "Quint least-used synthetic fixture";

const { getDefaultAccountPool, resetDefaultAccountPoolAfterCredentialReset } =
  await import("../src/accounts/account-pool.ts");
const { createRuntimeAccountStoragePolicy, saveAccount } = await import(
  "../src/auth/account-storage.ts"
);
const { testOutputPath } = await import("../../scripts/lib/test-output.ts");

const provider = "openai-codex";
const other = "anthropic-subscription";
const strategy = "least-used";
const cases = [];
const now = Date.now;
let time = 0;

async function scenario(name, work) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "quint-pool-least-used-"));
  process.env.ELIZA_HOME = root;
  process.env.ELIZA_STATE_DIR = root;
  resetDefaultAccountPoolAfterCredentialReset();
  time = 1_900_000_000_000;
  Date.now = () => time;
  try {
    const policy = createRuntimeAccountStoragePolicy(root);
    for (const providerId of [provider, other]) {
      for (const [index, id] of ["first", "second"].entries()) {
        saveAccount(
          {
            id,
            providerId,
            label: id,
            source: "oauth",
            credentials: {
              access: `fixture-${id}`,
              refresh: `fixture-refresh-${id}`,
              expires: time + 86_400_000,
            },
            createdAt: index + 1,
            updatedAt: index + 1,
          },
          policy,
        );
      }
    }
    await work();
    cases.push(name);
  } finally {
    Date.now = now;
    resetDefaultAccountPoolAfterCredentialReset();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function pick(providerId = provider, sessionKey) {
  const account = await getDefaultAccountPool().select({
    providerId,
    strategy,
    sessionKey,
  });
  assert(account);
  assert.equal(account.providerId, providerId);
  return account.id;
}

await scenario(
  "same-millisecond concurrent picks observe each other's stamps",
  async () => {
    assert.deepEqual(await Promise.all([pick(), pick()]), ["first", "second"]);
    assert.equal(await pick(), "first");
  },
);

await scenario(
  "selection preview is repeatable and leaves live selection order alone",
  async () => {
    const pool = getDefaultAccountPool();
    assert.deepEqual(pool.selectionState(provider, strategy), {
      activeAccountId: "first",
      reason: strategy,
    });
    assert.deepEqual(pool.selectionState(provider, strategy), {
      activeAccountId: "first",
      reason: strategy,
    });
    assert.equal(await pick(), "first");
    assert.equal(
      pool.selectionState(provider, strategy).activeAccountId,
      "second",
    );
    assert.equal(await pick(), "second");
  },
);

await scenario(
  "same account ids in different providers have independent stamps",
  async () => {
    assert.equal(await pick(provider), "first");
    assert.equal(await pick(other), "first");
    assert.equal(await pick(provider), "second");
    assert.equal(await pick(other), "second");
  },
);

await scenario(
  "affinity reuse leaves the burst ordering unchanged",
  async () => {
    assert.equal(await pick(provider, "session"), "first");
    assert.equal(await pick(), "second");
    assert.equal(await pick(provider, "session"), "first");
    assert.equal(await pick(), "first");
  },
);

await scenario(
  "restart drops in-memory stamps and retains recorded recency",
  async () => {
    assert.equal(await pick(), "first");
    assert.equal(
      getDefaultAccountPool().selectionState(provider, strategy)
        .activeAccountId,
      "second",
    );
    resetDefaultAccountPoolAfterCredentialReset();
    assert.equal(await pick(), "first");

    time += 100;
    await getDefaultAccountPool().recordCall(
      "first",
      { ok: true },
      { providerId: provider },
    );
    resetDefaultAccountPoolAfterCredentialReset();
    assert.equal(
      getDefaultAccountPool().get("first", provider)?.lastUsedAt,
      time,
    );
    assert.equal(await pick(), "second");
  },
);

await scenario(
  "usage orders accounts before the effective recency stamp",
  async () => {
    const pool = getDefaultAccountPool();
    const second = pool.get("second", provider);
    assert(second);
    await pool.upsert({
      ...second,
      usage: { sessionPct: 60, refreshedAt: time },
    });
    assert.equal(await pick(), "first");
    assert.equal(await pick(), "first");
  },
);

const output = testOutputPath("quint-account-pool-least-used");
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, "run-"));
fs.writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ cases }, null, 2)}\n`,
);
console.log(
  `Least-used selection passed ${cases.length} encrypted-pool scenarios. Evidence ${directory}`,
);
