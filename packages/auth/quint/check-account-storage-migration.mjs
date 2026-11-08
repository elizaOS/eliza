/** Exercises historical account bytes with the real vault key and storage APIs. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
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

const scratch = fs.mkdtempSync(path.join(tmpdir(), "quint-account-migration-"));
process.env.ELIZA_HOME = scratch;
process.env.ELIZA_STATE_DIR = scratch;
process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = "1";
process.env.ELIZA_VAULT_PASSPHRASE = "Quint migration synthetic fixture";
process.env.NODE_ENV = "production";
process.env.BUN_ENV = "production";
delete process.env.VITEST;

try {
  await checkMigration(scratch);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

async function checkMigration(root) {
  const { createRuntimeAccountStoragePolicy, listAccounts, loadAccount } =
    await import("../src/auth/account-storage.ts");
  const { decrypt } = await import("../src/vault/crypto.ts");
  const { loadDefaultMasterKeySync } = await import(
    "../src/vault/master-key.ts"
  );
  const { testOutputPath } = await import("../../scripts/lib/test-output.ts");

  const key = loadDefaultMasterKeySync();
  const provider = "openai-codex";
  const id = "fixture-account";
  const generation = "11111111-1111-4111-8111-111111111111";
  const canonical = (account) => `@elizaos/auth/account/${provider}/${account}`;
  const legacy = (account) =>
    `@elizaos/credentials/auth/account/${provider}/${account}`;
  const cases = [];
  const record = (account, existingGeneration) => ({
    id: account,
    providerId: provider,
    label: "Historical fixture",
    source: "oauth",
    credentials: {
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 2_000_000_000_000,
    },
    createdAt: 1,
    updatedAt: 2,
    lastUsedAt: 3,
    email: "fixture@example.test",
    userId: "fixture-user",
    organizationId: "fixture-org",
    ...(existingGeneration ? { credentialGeneration: existingGeneration } : {}),
  });

  // Build the historical v1 GCM wire bytes independently of today's writer.
  function envelope(value, aad) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const ciphertext = [
      "v1",
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      data.toString("base64"),
    ].join(":");
    return JSON.stringify({ schemaVersion: 2, ciphertext });
  }

  function scenario(name, exercise) {
    const policy = createRuntimeAccountStoragePolicy(
      fs.mkdtempSync(path.join(root, "case-")),
    );
    const directory = path.join(policy.authRoot, provider);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    exercise({ policy, directory, file: path.join(directory, `${id}.json`) });
    cases.push(name);
  }

  function readCanonical(file, account, original) {
    const disk = fs.readFileSync(file, "utf8");
    const stored = JSON.parse(disk);
    assert.equal(stored.schemaVersion, 2);
    assert(!disk.includes(original.credentials.access));
    assert.throws(() => decrypt(key, stored.ciphertext, legacy(account)));
    const decoded = JSON.parse(
      decrypt(key, stored.ciphertext, canonical(account)),
    );
    assert.match(
      decoded.credentialGeneration,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    assert.deepEqual(decoded, {
      ...original,
      credentialGeneration:
        original.credentialGeneration ?? decoded.credentialGeneration,
    });
    return { decoded, disk };
  }

  for (const format of [
    "legacy-aad",
    "canonical-without-generation",
    "plaintext",
  ]) {
    scenario(
      `canonicalizes ${format} and then reads without rewriting`,
      ({ policy, file }) => {
        const original = record(
          id,
          format === "legacy-aad" ? generation : undefined,
        );
        const bytes =
          format === "plaintext"
            ? JSON.stringify(original)
            : envelope(
                original,
                format === "legacy-aad" ? legacy(id) : canonical(id),
              );
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        const loaded = loadAccount(provider, id, policy);
        const { decoded, disk } = readCanonical(file, id, original);
        assert.deepEqual(loaded, decoded);
        assert.notEqual(disk, bytes);
        assert.deepEqual(loadAccount(provider, id, policy), loaded);
        assert.equal(fs.readFileSync(file, "utf8"), disk);
      },
    );
  }

  scenario(
    "rejects a foreign tag and authenticated wrong account id without writing",
    ({ policy, file }) => {
      const foreign = record("other-account", generation);
      for (const aad of [legacy(foreign.id), legacy(id)]) {
        const bytes = envelope(foreign, aad);
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        assert.throws(() => loadAccount(provider, id, policy), {
          code: "AUTH_CREDENTIAL_RECORD_CORRUPT",
        });
        assert.equal(fs.readFileSync(file, "utf8"), bytes);
      }
    },
  );

  scenario(
    "failed rename retains legacy bytes and the next read migrates",
    ({ policy, directory, file }) => {
      const original = record(id);
      const bytes = envelope(original, legacy(id));
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      const rename = fs.renameSync;
      let injected = false;
      fs.renameSync = (from, to) => {
        if (String(to) === file) {
          injected = true;
          throw Object.assign(new Error("fixture rename failure"), {
            code: "EIO",
          });
        }
        rename(from, to);
      };
      try {
        assert.throws(() => loadAccount(provider, id, policy), { code: "EIO" });
      } finally {
        fs.renameSync = rename;
      }
      assert(injected);
      assert.equal(fs.readFileSync(file, "utf8"), bytes);
      assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
      const loaded = loadAccount(provider, id, policy);
      assert.deepEqual(loaded, readCanonical(file, id, original).decoded);
    },
  );

  if (process.platform !== "win32") {
    scenario(
      "directory sync error withholds the result after canonical rename",
      ({ policy, directory, file }) => {
        const original = record(id);
        fs.writeFileSync(file, envelope(original, legacy(id)), { mode: 0o600 });
        const parent = fs.statSync(directory);
        const sync = fs.fsyncSync;
        let injected = false;
        fs.fsyncSync = (fd) => {
          const stat = fs.fstatSync(fd);
          if (stat.dev === parent.dev && stat.ino === parent.ino) {
            injected = true;
            throw Object.assign(new Error("fixture directory sync failure"), {
              code: "EIO",
            });
          }
          sync(fd);
        };
        try {
          assert.throws(() => loadAccount(provider, id, policy), {
            code: "EIO",
          });
        } finally {
          fs.fsyncSync = sync;
        }
        assert(injected);
        const { decoded, disk } = readCanonical(file, id, original);
        assert.deepEqual(loadAccount(provider, id, policy), decoded);
        assert.equal(fs.readFileSync(file, "utf8"), disk);
      },
    );
  }

  scenario(
    "a failed list retains an earlier canonical rewrite",
    ({ policy, directory }) => {
      for (const name of ["first.json", "second.json"])
        fs.writeFileSync(path.join(directory, name), "fixture", {
          mode: 0o600,
        });
      const order = fs.readdirSync(directory);
      assert.equal(order.length, 2);
      const account = path.basename(order[0], ".json");
      const first = path.join(directory, order[0]);
      const second = path.join(directory, order[1]);
      const original = record(account, generation);
      fs.writeFileSync(first, envelope(original, legacy(account)));
      fs.writeFileSync(second, "corrupt bytes");
      assert.deepEqual(fs.readdirSync(directory), order);
      assert.throws(() => listAccounts(provider, policy), {
        code: "AUTH_CREDENTIAL_RECORD_CORRUPT",
      });
      readCanonical(first, account, original);
      assert.equal(fs.readFileSync(second, "utf8"), "corrupt bytes");
    },
  );

  const output = testOutputPath("quint-account-storage-migration");
  fs.mkdirSync(output, { recursive: true });
  const report = fs.mkdtempSync(path.join(output, "run-"));
  fs.writeFileSync(
    path.join(report, "evidence.json"),
    `${JSON.stringify({ cases }, null, 2)}\n`,
  );
  console.log(
    `Account migration passed ${cases.length} historical-file scenarios. Evidence ${report}`,
  );
}
