/** Replays Quint publication traces through the real in-memory auth store. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Auth's source modules use Bun's supported TypeScript and module resolution.
// The shared runner enters through Node and preserves Bun's exit status.
if (!process.versions.bun) {
  const result = spawnSync("bun", [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}

const { MemoryBackend, NamespacedStoreBackend } = await import(
  "../src/server/auth/store-backends.ts"
);
const { TokenStore } = await import("../src/server/auth/token-store.ts");
const { testOutputPath } = await import("../../scripts/lib/test-output.ts");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const quintPackage = require.resolve("@informalsystems/quint/package.json");
const cli = path.join(path.dirname(quintPackage), "dist/src/cli.js");
const model = "packages/auth/quint/AuthStorePublication.qnt";
const output = testOutputPath("quint-auth-publication");
await mkdir(output, { recursive: true });
const traceDirectory = await mkdtemp(path.join(output, "traces-"));
const run = spawnSync(
  "node",
  [
    cli,
    "run",
    model,
    "--main=AuthStorePublication",
    "--backend=typescript",
    "--seed=20261107",
    "--max-samples=100",
    "--n-traces=100",
    "--max-steps=80",
    "--invariant=invariant",
    `--out-itf=${path.join(traceDirectory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (run.error) throw run.error;
if (run.signal) process.kill(process.pid, run.signal);
assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== "object") return value;
  if ("#bigint" in value) {
    const integer = Number(value["#bigint"]);
    assert(Number.isSafeInteger(integer));
    return integer;
  }
  if ("#map" in value) {
    return new Map(
      value["#map"].map(([key, entry]) => [decode(key), decode(entry)]),
    );
  }
  if ("#set" in value) return new Set(value["#set"].map(decode));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decode(entry)]),
  );
}

const traces = (await readdir(traceDirectory)).filter((file) =>
  /^trace-\d+\.itf\.json$/.test(file),
);
assert.equal(traces.length, 100);
let steps = 0;
const operations = new Set();
const outcomes = new Set();
const originalNow = Date.now;
try {
  for (const file of traces) {
    const trace = JSON.parse(
      await readFile(path.join(traceDirectory, file), "utf8"),
    );
    assert.equal(trace.vars.length, 1);
    assert.equal(trace.states.length, 81);
    const states = trace.states.map((state) => decode(state[trace.vars[0]]));
    let logicalTime = 0;
    Date.now = () => 1_000_000 + logicalTime * 1_000;
    const backend = new MemoryBackend();
    const stores = new Map([
      [
        1,
        new TokenStore({
          backend: new NamespacedStoreBackend(backend, "tenant"),
        }),
      ],
      [
        2,
        new TokenStore({
          backend: new NamespacedStoreBackend(backend, "tenant:1"),
        }),
      ],
    ]);
    try {
      await Promise.all(
        [...stores.values()].map((store) =>
          store.store("claim", "available", 2_000),
        ),
      );
      for (const state of states) {
        logicalTime = state.now;
        const store = stores.get(state.namespace);
        assert(store);
        operations.add(state.operation);
        switch (state.operation) {
          case "init":
          case "tick":
            break;
          case "publish":
            assert.equal(
              await store.publish([
                {
                  key: "claim",
                  expected: "available",
                  value: String(state.owner),
                  expiresAt: 1_002_000,
                },
                {
                  key: `token:${state.owner}`,
                  value: "authenticated",
                  expiresAt: 1_002_000,
                },
              ]),
              state.accepted,
            );
            if (state.accepted) {
              outcomes.add("publication");
              if (state.consumed.get(state.namespace).has(state.owner)) {
                outcomes.add("consumed-token-retry");
              }
            } else if (state.now >= 2) {
              outcomes.add("expired-publication");
            } else if (state.previousClaim.get(state.namespace) > 0) {
              outcomes.add("competing-publisher");
            }
            break;
          case "consume":
            assert.equal(
              await store.consume(`token:${state.owner}`),
              state.accepted ? "authenticated" : null,
            );
            if (state.accepted) outcomes.add("consumption");
            break;
          case "revoke":
            assert.equal(
              await store.compareDelete("claim", String(state.owner)),
              state.accepted,
            );
            if (state.accepted) outcomes.add("revocation");
            break;
          default:
            throw new Error(`Unknown trace operation ${state.operation}`);
        }
        for (const [namespace, target] of stores) {
          const claim = state.claim.get(namespace);
          const expectedClaim =
            logicalTime >= 2 || claim === -1
              ? null
              : claim === 0
                ? "available"
                : String(claim);
          assert.equal(await target.verify("claim"), expectedClaim);
          for (const owner of [1, 2]) {
            const expectedToken =
              logicalTime < 2 && state.tokens.get(namespace).has(owner)
                ? "authenticated"
                : null;
            assert.equal(await target.verify(`token:${owner}`), expectedToken);
          }
        }
        if (state.operation !== "init") steps += 1;
      }
    } finally {
      backend.destroy();
    }
  }
} finally {
  Date.now = originalNow;
}
assert.deepEqual([...operations].sort(), [
  "consume",
  "init",
  "publish",
  "revoke",
  "tick",
]);
assert.deepEqual([...outcomes].sort(), [
  "competing-publisher",
  "consumed-token-retry",
  "consumption",
  "expired-publication",
  "publication",
  "revocation",
]);
const sourceFiles = [
  model,
  "packages/auth/quint/AuthStorePublication.cases.json",
  "packages/auth/quint/check-auth-publication.mjs",
  "packages/auth/src/server/auth/store-backends.ts",
  "packages/auth/src/server/auth/token-store.ts",
];
const sources = {};
for (const file of sourceFiles) {
  sources[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
}
await writeFile(
  path.join(output, "results.json"),
  `${JSON.stringify(
    {
      result: "passed",
      seed: 20261107,
      traces: traces.length,
      steps,
      sources,
      outcomes: [...outcomes].sort(),
      backend: "MemoryBackend via NamespacedStoreBackend and TokenStore",
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Auth publication conformance passed ${traces.length} traces and ${steps} steps`,
);
