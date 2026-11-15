/** Replays provider deletion admission and rollback against encrypted files. */
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

const {
  commitAccountDeletions,
  createIsolatedAccountStoragePolicy,
  loadAccount,
  saveAccount,
  updateAccountMetadata,
} = await import("../src/auth/account-storage.ts");
const { deleteProviderCredentials, preflightProviderCredentialDeletion } =
  await import("../src/auth/credentials.ts");
const { testOutputPath } = await import("../../scripts/lib/test-output.ts");

const provider = "openai-codex";
const siblingProvider = "anthropic-subscription";
const targetIds = ["first", "second"];
const accountFile = (policy, accountProvider, id) =>
  path.join(policy.authRoot, accountProvider, `${id}.json`);
const readFiles = (files) => files.map((file) => fs.readFileSync(file));
const cases = [];

function store(policy, accountProvider, id) {
  const access = `fixture-access-${id}`;
  saveAccount(
    {
      id,
      providerId: accountProvider,
      label: id,
      source: "oauth",
      credentials: {
        access,
        refresh: `fixture-refresh-${id}`,
        expires: 2_000_000_000_000,
      },
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
  );
  const file = accountFile(policy, accountProvider, id);
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(JSON.parse(raw).schemaVersion, 2);
  assert(!raw.includes(access));
  return file;
}

function scenario(name, exercise) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "quint-provider-deletion-"));
  try {
    const policy = createIsolatedAccountStoragePolicy(root);
    const targets = targetIds.map((id) => store(policy, provider, id));
    const sibling = store(policy, siblingProvider, "first");
    const files = [...targets, sibling];
    const before = readFiles(files);
    exercise({ policy, targets, sibling, files, before });
    cases.push(name);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

scenario(
  "invalid inventory retains every encrypted record",
  ({ policy, files, before }) => {
    const invalid = path.join(policy.authRoot, provider, "invalid id.json");
    fs.writeFileSync(invalid, "fixture", { mode: 0o600 });
    assert.throws(
      () => preflightProviderCredentialDeletion([provider], policy),
      {
        code: "AUTH_CREDENTIAL_ACCOUNT_ID_INVALID",
      },
    );
    assert.deepEqual(readFiles(files), before);
    assert.equal(fs.readFileSync(invalid, "utf8"), "fixture");
  },
);

scenario(
  "same-generation file rewrite fences the entire stale plan",
  ({ policy, targets, sibling, files, before }) => {
    const plan = preflightProviderCredentialDeletion([provider], policy);
    assert.deepEqual(readFiles(files), before);

    const current = loadAccount(provider, "second", policy);
    assert(current);
    const updated = updateAccountMetadata(
      provider,
      "second",
      { label: "updated label" },
      policy,
      current.credentialGeneration,
    );
    assert.equal(updated.kind, "updated");
    assert.equal(
      updated.record.credentialGeneration,
      current.credentialGeneration,
    );
    const rewritten = readFiles(files);
    assert.notDeepEqual(rewritten[1], before[1]);

    assert.throws(() => commitAccountDeletions(plan), {
      code: "AUTH_CREDENTIAL_DELETE_TARGET_CHANGED",
    });
    assert.deepEqual(readFiles(files), rewritten);

    assert.equal(deleteProviderCredentials(provider, policy), targets.length);
    assert(targets.every((file) => !fs.existsSync(file)));
    assert.deepEqual(fs.readFileSync(sibling), before[2]);
  },
);

scenario(
  "changed inventory fences the entire stale plan",
  ({ policy, files }) => {
    const plan = preflightProviderCredentialDeletion([provider], policy);
    const added = store(policy, provider, "added");
    const inventory = [...files, added];
    const beforeCommit = readFiles(inventory);
    assert.throws(() => commitAccountDeletions(plan), {
      code: "AUTH_CREDENTIAL_DELETE_INVENTORY_CHANGED",
    });
    assert.deepEqual(readFiles(inventory), beforeCommit);
  },
);

scenario(
  "second unlink error restores exact ciphertext from the first unlink",
  ({ policy, targets, files, before }) => {
    const plan = preflightProviderCredentialDeletion([provider], policy);
    const unlink = fs.unlinkSync;
    let removed;
    let injected = false;
    fs.unlinkSync = (file) => {
      if (!targets.includes(String(file))) return unlink(file);
      if (removed) {
        assert(!fs.existsSync(removed));
        assert(fs.existsSync(file));
        injected = true;
        throw Object.assign(new Error("fixture unlink failure"), {
          code: "EIO",
        });
      }
      unlink(file);
      removed = String(file);
    };
    try {
      assert.throws(() => commitAccountDeletions(plan), {
        code: "AUTH_CREDENTIAL_DELETE_TRANSACTION_FAILED",
        context: { deleted: 1, rollbackFailures: [] },
      });
    } finally {
      fs.unlinkSync = unlink;
    }
    assert(injected, "Fault must occur after a real unlink");
    assert.deepEqual(readFiles(files), before);
    assert.equal(fs.statSync(removed).mode & 0o777, 0o600);
  },
);

const output = testOutputPath("quint-account-provider-deletion");
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, "run-"));
fs.writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ cases }, null, 2)}\n`,
);
console.log(
  `Provider deletion passed ${cases.length} encrypted-filesystem scenarios. Evidence ${directory}`,
);
