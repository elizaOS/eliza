/** Replays selection snapshots through the real AccountPool and await barriers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.versions.bun) {
  const result = spawnSync(
    "bun",
    ["--conditions=eliza-source", fileURLToPath(import.meta.url)],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}
const { AccountPool } = await import("../src/accounts/account-pool.ts");
const { testOutputPath } = await import("../../scripts/lib/test-output.ts");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const cli = path.join(
  path.dirname(require.resolve("@informalsystems/quint/package.json")),
  "dist/src/cli.js",
);
const model = "packages/auth/quint/AccountPoolAffinity.qnt";
const output = testOutputPath("quint-account-pool");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
function generate(args) {
  const result = spawnSync("node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
generate([
  "run",
  model,
  "--main=AccountPoolAffinity",
  "--backend=typescript",
  "--seed=20261110",
  "--max-samples=100",
  "--n-traces=100",
  "--max-steps=30",
  "--invariant=invariant",
  `--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
  "--verbosity=0",
]);
generate([
  "test",
  model,
  "--main=AccountPoolAffinity",
  "--backend=typescript",
  "--seed=20261110",
  `--out-itf=${path.join(directory, "scenario-{test}-{seq}.itf.json")}`,
  "--verbosity=0",
]);
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== "object") return value;
  if ("#bigint" in value) return Number(value["#bigint"]);
  if ("#set" in value) return new Set(value["#set"].map(decode));
  if ("#map" in value)
    return new Map(
      value["#map"].map(([key, entry]) => [decode(key), decode(entry)]),
    );
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decode(entry)]),
  );
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
const providers = new Map([
  [1, "openai-api"],
  [2, "anthropic-api"],
]);
const records = new Map([
  [1, { id: "same-id", providerId: providers.get(1) }],
  [2, { id: "second", providerId: providers.get(1) }],
  [3, { id: "same-id", providerId: providers.get(2) }],
]);
const traces = (await readdir(directory)).filter((file) =>
  file.endsWith(".itf.json"),
);
assert.equal(traces.filter((file) => file.startsWith("trace-")).length, 100);
assert.equal(traces.filter((file) => file.startsWith("scenario-")).length, 4);
let transitions = 0;
let selections = 0;
let failures = 0;
let overlapping = 0;
const observed = new Set();
for (const file of traces) {
  const trace = JSON.parse(await readFile(path.join(directory, file), "utf8"));
  assert.deepEqual(trace.vars, ["s"]);
  const states = trace.states.map((state) => decode(state.s));
  let backing = Object.fromEntries(
    [...records].map(([id, value]) => [
      id,
      {
        ...value,
        label: `account-${id}`,
        source: "api-key",
        enabled: true,
        priority: id,
        createdAt: id,
        health: "ok",
      },
    ]),
  );
  let selectedRequest;
  let sequence = 0;
  const requests = new Map();
  function makePool() {
    return new AccountPool({
      readAccounts: () => {
        assert(selectedRequest);
        const sentinel = {
          id: selectedRequest.sentinel,
          providerId: selectedRequest.provider,
          label: "expired-await-barrier",
          source: "api-key",
          enabled: false,
          priority: 99,
          createdAt: 0,
          health: "ok",
          subscriptionEndsAt: 1,
        };
        return { ...backing, [sentinel.id]: sentinel };
      },
      writeAccount: async (account) => {
        assert(selectedRequest);
        const request = selectedRequest;
        assert.equal(account.id, request.sentinel);
        assert.equal(account.health, "expired");
        request.entered.resolve();
        await request.release.promise;
      },
    });
  }
  let pool = makePool();
  try {
    for (const state of states.slice(1)) {
      const slot = state.slot;
      if (state.operation === "begin") {
        const call = state.calls.get(slot);
        const request = {
          provider: providers.get(call.provider),
          sentinel: `expired-${sequence++}`,
          entered: deferred(),
          release: deferred(),
          settled: false,
        };
        selectedRequest = request;
        request.result = pool
          .select({
            providerId: request.provider,
            sessionKey: `session-${call.session}`,
            strategy: "round-robin",
          })
          .then(
            (value) => {
              request.settled = true;
              return { value };
            },
            (error) => {
              request.settled = true;
              return { error };
            },
          );
        requests.set(slot, request);
        await request.entered.promise;
        selectedRequest = null;
        selections++;
        if (
          [...requests.values()].filter((entry) => !entry.settled).length === 2
        )
          overlapping++;
      } else if (state.operation === "finish" || state.operation === "fail") {
        const request = requests.get(slot);
        assert(request && !request.settled);
        if (state.operation === "fail") {
          request.failure = new Error("injected metadata persistence failure");
          request.release.reject(request.failure);
          failures++;
        } else {
          request.release.resolve();
        }
        const result = await request.result;
        const expected = state.calls.get(slot).result;
        if (expected === -1) {
          assert.equal(result.error, request.failure);
        } else if (expected === 0) {
          assert.deepEqual(result, { value: null });
        } else {
          assert.equal(result.error, undefined);
          assert.equal(result.value.id, records.get(expected).id);
          assert.equal(
            result.value.providerId,
            records.get(expected).providerId,
          );
        }
      } else if (state.operation === "enable") {
        backing = {
          ...backing,
          [state.key]: {
            ...backing[state.key],
            enabled: state.enabled.has(state.key),
          },
        };
      } else if (state.operation === "restart") {
        for (const request of requests.values()) assert(request.settled);
        requests.clear();
        pool = makePool();
      } else {
        assert.fail(`unknown operation ${state.operation}`);
      }
      for (const [id, call] of state.calls) {
        if (call.stage === "waiting")
          assert.equal(requests.get(id)?.settled, false);
      }
      observed.add(state.operation);
      transitions++;
    }
  } finally {
    for (const request of requests.values()) {
      if (!request.settled)
        request.release.reject(new Error("trace ended before settlement"));
    }
    await Promise.all([...requests.values()].map((request) => request.result));
  }
}
for (const operation of ["begin", "finish", "fail", "enable", "restart"])
  assert(observed.has(operation));
assert(selections > 0 && failures > 0 && overlapping > 0);
const evidence = {
  model,
  sha256: createHash("sha256")
    .update(await readFile(path.resolve(root, model)))
    .digest("hex"),
  seed: 20261110,
  traces: traces.length,
  transitions,
  selections,
  failures,
  overlapping,
  implementation:
    "Real AccountPool.select with deferred expiry metadata writes and immutable inventory replacement. Includes four specified scenario traces.",
  limitations:
    "Round-robin with two providers, two sessions, three accounts and four calls. Provider credentials and disk-backed metadata locking are checked by owning integration tests, not this adapter.",
};
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
  `Account-pool conformance passed: ${traces.length} traces, ${transitions} transitions, ${overlapping} concurrent call observations.`,
);
console.log(`Evidence: ${path.join(directory, "evidence.json")}`);
