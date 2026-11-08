/** Replays Quint refresh and metadata races against encrypted account files and public APIs. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.versions.bun) {
  const run = spawnSync(
    "bun",
    ["--conditions=eliza-source", fileURLToPath(import.meta.url)],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  if (run.error) throw run.error;
  if (run.signal) process.kill(process.pid, run.signal);
  process.exit(run.status ?? 1);
}
const {
  createIsolatedAccountStoragePolicy,
  deleteAccount,
  loadAccount,
  saveAccount,
  updateAccountCredentialsIfUnchanged,
  updateAccountMetadata,
} = await import("../src/auth/account-storage.ts");
const { testOutputPath } = await import("../../scripts/lib/test-output.ts");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const cli = path.join(
  path.dirname(require.resolve("@informalsystems/quint/package.json")),
  "dist/src/cli.js",
);
const model = "packages/auth/quint/AccountCredentialGeneration.qnt";
const output = testOutputPath("quint-account-generation");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const tracesDirectory = path.join(directory, "traces");
await mkdir(tracesDirectory);
const count = 100;
const stepsPerTrace = 30;
const run = spawnSync(
  "node",
  [
    cli,
    "run",
    model,
    "--main=AccountCredentialGeneration",
    "--backend=typescript",
    "--seed=20261109",
    `--max-samples=${count}`,
    `--n-traces=${count}`,
    `--max-steps=${stepsPerTrace}`,
    "--invariant=invariant",
    `--out-itf=${path.join(tracesDirectory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (run.error) throw run.error;
assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== "object") return value;
  if ("#bigint" in value) {
    const integer = Number(value["#bigint"]);
    assert(Number.isSafeInteger(integer));
    return integer;
  }
  if ("#map" in value)
    return new Map(
      value["#map"].map(([key, entry]) => [decode(key), decode(entry)]),
    );
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decode(entry)]),
  );
}
const providers = new Map([
  [1, "openai-codex"],
  [2, "anthropic-subscription"],
]);
const accountId = "same-account";
function credentials(value, includeToken) {
  return {
    access: `access-${value}`,
    refresh: `refresh-${value}`,
    expires: 2_000_000_000_000,
    ...(includeToken ? { idToken: `identity-${value}` } : {}),
  };
}
function record(key, value, includeToken) {
  return {
    id: accountId,
    providerId: providers.get(key),
    label: `label-${key}`,
    source: "oauth",
    credentials: credentials(value, includeToken),
    createdAt: 1,
    updatedAt: 1,
  };
}
const files = (await readdir(tracesDirectory)).filter((file) =>
  /^trace-\d+\.itf\.json$/.test(file),
);
assert.equal(files.length, count);
const outcomes = new Set();
let transitions = 0;
let encryptedFiles = 0;
for (const [index, file] of files.entries()) {
  const trace = JSON.parse(
    await readFile(path.join(tracesDirectory, file), "utf8"),
  );
  assert.equal(trace.vars.length, 1);
  assert.equal(trace.states.length, stepsPerTrace + 1);
  const states = trace.states.map((entry) => decode(entry[trace.vars[0]]));
  const storage = await mkdtemp(
    path.join(tmpdir(), `quint-account-generation-${index}-`),
  );
  const policy = createIsolatedAccountStoragePolicy(storage);
  const generations = new Map();
  const held = new Map();
  for (const key of providers.keys()) {
    const saved = saveAccount(record(key, key, true), policy);
    generations.set(key, saved.credentialGeneration);
  }
  async function check(expected) {
    for (const key of providers.keys()) {
      const actual = loadAccount(providers.get(key), accountId, policy);
      const entry = expected.records.get(key);
      if (entry.generation === 0) {
        assert.equal(actual, null);
        continue;
      }
      assert(actual);
      assert.equal(
        actual.credentialGeneration,
        generations.get(entry.generation),
      );
      assert.equal(actual.credentials.access, `access-${entry.credential}`);
      assert.equal(actual.credentials.refresh, `refresh-${entry.credential}`);
      assert.equal(
        actual.credentials.idToken,
        entry.idToken === 0 ? undefined : `identity-${entry.idToken}`,
      );
      assert.equal(actual.label, `label-${entry.label}`);
      assert.equal(actual.createdAt, 1);
      const location = path.join(
        policy.authRoot,
        providers.get(key),
        `${accountId}.json`,
      );
      assert.equal((await stat(location)).mode & 0o777, 0o600);
      const serialized = await readFile(location, "utf8");
      assert.equal(JSON.parse(serialized).schemaVersion, 2);
      assert(!serialized.includes(`access-${entry.credential}`));
      encryptedFiles++;
    }
  }
  await check(states[0]);
  for (const state of states.slice(1)) {
    const provider = providers.get(state.key);
    let result;
    switch (state.operation) {
      case "begin": {
        const loaded = loadAccount(provider, accountId, policy);
        assert(loaded);
        held.set(state.reader, loaded.credentialGeneration);
        result = "loaded";
        break;
      }
      case "refresh": {
        const refreshed = updateAccountCredentialsIfUnchanged(
          provider,
          accountId,
          held.get(state.reader),
          credentials(state.value, state.includesIdToken),
          policy,
        );
        result = refreshed.kind;
        if (refreshed.kind === "updated") {
          generations.set(
            state.records.get(state.key).generation,
            refreshed.record.credentialGeneration,
          );
        }
        break;
      }
      case "save": {
        const saved = saveAccount(
          record(state.key, state.value, state.includesIdToken),
          policy,
        );
        generations.set(
          state.records.get(state.key).generation,
          saved.credentialGeneration,
        );
        result = "saved";
        break;
      }
      case "metadata":
        result = updateAccountMetadata(
          provider,
          accountId,
          { label: `label-${state.value}` },
          policy,
        ).kind;
        break;
      case "conditional-metadata": {
        const expected = held.get(state.reader);
        assert(expected, "Conditional metadata needs a captured generation");
        const updated = updateAccountMetadata(
          provider,
          accountId,
          { label: `label-${state.value}` },
          policy,
          expected,
        );
        result = updated.kind;
        if (updated.kind !== "missing") {
          assert.deepEqual(
            updated.record,
            loadAccount(provider, accountId, policy),
            "Metadata outcome must carry the current encrypted record",
          );
        }
        break;
      }
      case "remove":
        deleteAccount(provider, accountId, policy);
        result = "deleted";
        break;
      default:
        assert.fail(`unknown operation ${state.operation}`);
    }
    assert.equal(
      result,
      state.result,
      `${file}/${transitions}/${state.operation}`,
    );
    await check(state);
    outcomes.add(`${state.operation}/${result}`);
    transitions++;
  }
  await rm(storage, { recursive: true, force: true });
}
for (const outcome of [
  "begin/loaded",
  "refresh/updated",
  "refresh/changed",
  "refresh/missing",
  "save/saved",
  "metadata/updated",
  "metadata/missing",
  "conditional-metadata/updated",
  "conditional-metadata/changed",
  "conditional-metadata/missing",
  "remove/deleted",
]) {
  assert(outcomes.has(outcome), `missing exercised outcome ${outcome}`);
}
const evidence = {
  model,
  sha256: createHash("sha256")
    .update(await readFile(path.join(root, model)))
    .digest("hex"),
  seed: 20261109,
  traces: files.length,
  transitions,
  encryptedFiles,
  outcomes: [...outcomes].sort(),
  storage:
    "Actual account-storage public APIs, private files, AES-GCM envelopes and filesystem mutation locks",
  assumptions:
    "Two providers, one common account id, two one-shot captured refresh or metadata callers, one explicit replacement. No process death or injected filesystem errors.",
};
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
  `Account generation conformance passed: ${files.length} traces, ${transitions} transitions, ${encryptedFiles} encrypted file observations.`,
);
console.log(`Evidence: ${path.join(directory, "evidence.json")}`);
