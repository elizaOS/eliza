import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireExclusiveDatabaseLease } from "./database-lease.mjs";
import {
  initializeResearchConfiguration,
  readResearchConfiguration,
  rotateResearchConfiguration,
} from "./research-configuration.mjs";
import { openResearchStore } from "./research-store.mjs";

const actor = { name: "fixture_operator", role: "admin" };
const measurementPolicy = {
  validateDataset: (data) => assert.equal(data.study, "fixture"),
  report: (data) => data,
};
const openStore = (options) =>
  openResearchStore({ ...options, measurementPolicy });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "research-admin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = {
    directory,
    port: 4190,
    retentionMs: 60000,
    maxEvents: 10,
    operatorName: actor.name,
    databaseName: "research.sqlite",
  };
  return { directory, options };
}
test("private initialization records only a token hash and refuses existing configuration", (t) => {
  const f = fixture(t),
    paths = initializeResearchConfiguration(f.options);
  const config = readResearchConfiguration(paths.configPath),
    token = readFileSync(paths.tokenPath, "utf8").trim();
  assert.equal(
    config.operators[0].tokenSha256,
    createHash("sha256").update(token).digest("hex"),
  );
  assert.equal(JSON.stringify(config).includes(token), false);
  assert.equal(statSync(paths.tokenPath).mode & 0o777, 0o600);
  assert.throws(() => initializeResearchConfiguration(f.options));
  assert.equal(readFileSync(paths.tokenPath, "utf8").trim(), token);
  assert.equal(existsSync(config.databasePath), false);
});
test("initialization failure preserves a preexisting config and removes only its new token", (t) => {
  const f = fixture(t),
    path = join(f.directory, "config.json");
  writeFileSync(path, "existing", { mode: 0o600 });
  assert.throws(() => initializeResearchConfiguration(f.options));
  assert.equal(readFileSync(path, "utf8"), "existing");
  assert.equal(existsSync(join(f.directory, "operator-token")), false);
});
test("configuration refuses public files and symlink indirection", (t) => {
  const f = fixture(t),
    { configPath } = initializeResearchConfiguration(f.options);
  chmodSync(configPath, 0o644);
  assert.throws(() => readResearchConfiguration(configPath));
  chmodSync(configPath, 0o600);
  const alias = join(f.directory, "alias");
  symlinkSync(configPath, alias);
  assert.throws(() => readResearchConfiguration(alias));
});
test("offline rotation preserves encrypted research and audit with closed recovery files", (t) => {
  const f = fixture(t),
    { configPath: path } = initializeResearchConfiguration(f.options),
    config = readResearchConfiguration(path);
  let store = openStore({
    path: config.databasePath,
    key: Buffer.from(config.encryptionKey, "base64"),
    retentionMs: config.retentionMs,
    maxEvents: config.maxEvents,
  });
  store.dataset(actor, {
    expectedRevision: 0,
    data: { study: "fixture", participants: [], tasks: [], coverage: [] },
  });
  store.close();
  const release = acquireExclusiveDatabaseLease(config.databasePath);
  assert.throws(() => rotateResearchConfiguration({ path, openStore, actor }));
  assert.equal(existsSync(`${path}.rotation-previous`), false);
  release();
  const receipt = rotateResearchConfiguration({ path, openStore, actor }),
    next = readResearchConfiguration(path);
  assert.notEqual(next.encryptionKey, config.encryptionKey);
  assert.equal(
    readResearchConfiguration(receipt.recoveryPath).encryptionKey,
    config.encryptionKey,
  );
  assert.equal(existsSync(`${path}.rotation-next`), false);
  assert.equal(existsSync(`${config.databasePath}.lock`), false);
  store = openStore({
    path: config.databasePath,
    key: Buffer.from(next.encryptionKey, "base64"),
    retentionMs: next.retentionMs,
    maxEvents: next.maxEvents,
  });
  assert.equal(store.report(actor).revision, 1);
  assert.ok(store.audit(actor).some((e) => e.action === "rotate-storage-key"));
  store.close();
  assert.throws(() =>
    openStore({
      path: config.databasePath,
      key: Buffer.from(config.encryptionKey, "base64"),
      retentionMs: config.retentionMs,
      maxEvents: config.maxEvents,
    }),
  );
  assert.throws(() => rotateResearchConfiguration({ path, openStore, actor }));
  assert.equal(
    readResearchConfiguration(path).encryptionKey,
    next.encryptionKey,
  );
});
test("failed database rotation retains both recovery keys and releases its lease", (t) => {
  const f = fixture(t),
    { configPath: path } = initializeResearchConfiguration(f.options),
    before = readResearchConfiguration(path);
  let closed = false;
  assert.throws(
    () =>
      rotateResearchConfiguration({
        path,
        actor,
        openStore: () => ({
          rotateKey() {
            throw new Error("controlled storage failure");
          },
          close() {
            closed = true;
          },
        }),
      }),
    /controlled storage failure/,
  );
  assert.equal(closed, true);
  assert.equal(
    readResearchConfiguration(path).encryptionKey,
    before.encryptionKey,
  );
  assert.equal(
    readResearchConfiguration(`${path}.rotation-previous`).encryptionKey,
    before.encryptionKey,
  );
  assert.notEqual(
    readResearchConfiguration(`${path}.rotation-next`).encryptionKey,
    before.encryptionKey,
  );
  assert.equal(existsSync(`${before.databasePath}.lock`), false);
});
