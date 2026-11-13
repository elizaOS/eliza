/** Replays Quint recovery traces against the real host, filesystem and HTTP. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import {
  createNativeCloudAuth,
  SIGN_IN_CONFLICT,
} from "../native-host/cloud-enrollment.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const cli = path.join(
  path.dirname(require.resolve("@informalsystems/quint/package.json")),
  "dist/src/cli.js",
);
const model = "packages/auth/quint/NativeEnrollmentRecovery.qnt";
const output = testOutputPath("quint-native-enrollment");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const tracesDirectory = path.join(directory, "traces");
await mkdir(tracesDirectory);
const traceCount = 1000;
const traceSteps = 20;
const generated = spawnSync(
  process.execPath,
  [
    cli,
    "run",
    model,
    "--main=NativeEnrollmentRecovery",
    "--backend=typescript",
    "--seed=20261108",
    `--max-samples=${traceCount}`,
    `--n-traces=${traceCount}`,
    `--max-steps=${traceSteps}`,
    "--invariant=invariant",
    `--out-itf=${path.join(tracesDirectory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (generated.error) throw generated.error;
assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== "object") return value;
  if ("#bigint" in value) {
    const result = Number(value["#bigint"]);
    assert(Number.isSafeInteger(result));
    return result;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decode(entry)]),
  );
}

const secret = `eliza_${"a".repeat(64)}`;
const credentialId = "00000000-0000-4000-8000-000000000001";
const originTime = 2_000_000_000_000;
const binding = {
  clientId: "org.example.native",
  environment: "test",
  redirectUri: "https://native.example/callback",
};
const receipt = {
  version: 1,
  acknowledgeBy: new Date(originTime + 2_000).toISOString(),
  proof: {
    ...binding,
    state: "a".repeat(43),
    code: "b".repeat(43),
    codeVerifier: "c".repeat(43),
    credentialId,
    secret,
  },
};
let current;
let serverFailure;
const server = http.createServer(async (request, response) => {
  try {
    assert(current, "request outside a trace");
    const harness = current;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const reply = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/api/v1/app-auth/mobile/ack") {
      harness.requests.ack++;
      assert.equal(request.method, "POST");
      assert.deepEqual(
        JSON.parse(Buffer.concat(chunks).toString()),
        receipt.proof,
      );
      if (
        harness.remote === "revoked" ||
        (harness.remote === "issued" && harness.now >= 2)
      ) {
        reply(410, { error: "expired" });
        return;
      }
      if (harness.fault === "ack-before") {
        meaningful.add("resume/ack-before");
        reply(503, { error: "unavailable" });
        return;
      }
      harness.remote = "acknowledged";
      await harness.pause("ack");
      if (harness.fault === "ack-after") {
        meaningful.add("resume/ack-after");
        response.destroy();
        return;
      }
      if (harness.fault === "ack-invalid") meaningful.add("resume/ack-invalid");
      reply(200, {
        status: "acknowledged",
        credentialId:
          harness.fault === "ack-invalid" ? "wrong-credential" : credentialId,
        expiresAt: new Date(originTime + 10_000).toISOString(),
      });
      return;
    }
    assert.equal(request.url, "/api/v1/api-keys/current");
    assert.equal(request.method, "DELETE");
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    harness.requests.revoke++;
    if (harness.fault === "revoke-before") {
      meaningful.add(`${harness.operation}/revoke-before`);
      reply(503, { error: "unavailable" });
      return;
    }
    harness.remote = "revoked";
    if (harness.fault === "revoke-after") {
      meaningful.add(`${harness.operation}/revoke-after`);
      response.destroy();
      return;
    }
    reply(200, {
      success: true,
      status: "revoked",
      credentialId,
      revokedAt: new Date(originTime).toISOString(),
    });
  } catch (error) {
    serverFailure = error;
    response.destroy();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const api = `http://127.0.0.1:${server.address().port}`;

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createHarness(initial, index) {
  const storage = path.join(directory, `storage-${index}`);
  await mkdir(storage, { mode: 0o700 });
  const pendingPath = path.join(storage, "pending.json");
  const activePath = path.join(storage, "active.txt");
  const saved = structuredClone(receipt);
  if (!initial.bindingMatches) saved.proof.environment = "wrong";
  await writeFile(pendingPath, JSON.stringify(saved), { mode: 0o600 });
  if (initial.durable.active)
    await writeFile(activePath, secret, { mode: 0o600 });
  const harness = {
    remote: initial.durable.remote,
    now: initial.now,
    fault: "none",
    operation: "init",
    gate: null,
    requests: { ack: 0, revoke: 0 },
    activations: 0,
    async pause(cut) {
      if (this.gate?.cut !== cut) return;
      this.gate.entered.resolve();
      await this.gate.release.promise;
    },
    async mutate(name, effect) {
      if (this.fault === `${name}-before`) {
        meaningful.add(`${this.operation}/${this.fault}`);
        throw new Error(`injected ${name} before commit`);
      }
      await effect();
      if (this.fault === `${name}-after`) {
        meaningful.add(`${this.operation}/${this.fault}`);
        throw new Error(`injected ${name} after commit`);
      }
    },
    makeAuth() {
      return createNativeCloudAuth({
        api,
        auth: api,
        appName: "Quint enrollment conformance",
        binding,
        pendingStore: {
          read: async () => {
            const value = await readOptional(pendingPath);
            await harness.pause("read");
            return value;
          },
          write: async (value) =>
            harness.mutate("journal", async () => {
              await writeFile(`${pendingPath}.tmp`, value, { mode: 0o600 });
              await rename(`${pendingPath}.tmp`, pendingPath);
            }),
          clear: async () => {
            await harness.mutate("clear", () =>
              rm(pendingPath, { force: true }),
            );
            await harness.pause("clear");
          },
        },
        readActive: () => readOptional(activePath),
        clearActive: () =>
          harness.mutate("active", () => rm(activePath, { force: true })),
        activate: async (value, guard) => {
          assert.equal(value, secret);
          harness.activations++;
          await harness.pause("activate");
          await harness.mutate("activate", async () => {
            guard();
            await writeFile(activePath, value, { mode: 0o600 });
          });
          await harness.pause("activate-commit");
        },
      });
    },
    async durable() {
      const pending = await readOptional(pendingPath);
      return {
        pending: pending
          ? JSON.parse(pending).kind === "revocation"
            ? "revocation"
            : "activation"
          : "none",
        active: (await readOptional(activePath)) === secret,
        remote: this.remote,
      };
    },
    async close() {
      await rm(storage, { recursive: true, force: true });
    },
  };
  harness.auth = harness.makeAuth();
  return harness;
}

async function outcome(operation) {
  try {
    return (await operation()).status;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    return "error";
  }
}

async function race(harness, cut) {
  harness.gate = { cut, entered: deferred(), release: deferred() };
  const resumed = harness.auth.handle("resume").then(
    () => {
      throw new Error("cancelled resume unexpectedly succeeded");
    },
    (error) => error,
  );
  await Promise.race([
    harness.gate.entered.promise,
    new Promise((_, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`race never reached ${cut}`)),
        5_000,
      );
      timeout.unref();
    }),
  ]);
  await assert.rejects(
    harness.auth.handle("resume"),
    (error) => error.code === SIGN_IN_CONFLICT.busy,
  );
  const cancelled = harness.auth.cancel();
  await assert.rejects(
    harness.auth.cancel(),
    (error) => error.code === SIGN_IN_CONFLICT.cancelling,
  );
  harness.gate.release.resolve();
  const error = await resumed;
  assert.equal(error.code, SIGN_IN_CONFLICT.cancelled);
  const result = await cancelled;
  harness.gate = null;
  return result.status;
}

const files = (await readdir(tracesDirectory)).filter((file) =>
  /^trace-\d+\.itf\.json$/.test(file),
);
assert.equal(files.length, traceCount);
const exercised = new Set();
const meaningful = new Set();
let steps = 0;
const originalNow = Date.now;
try {
  for (const [index, file] of files.entries()) {
    const trace = JSON.parse(
      await readFile(path.join(tracesDirectory, file), "utf8"),
    );
    assert.equal(trace.vars.length, 1);
    assert.equal(trace.states.length, traceSteps + 1);
    const states = trace.states.map((entry) => decode(entry[trace.vars[0]]));
    const harness = await createHarness(states[0], index);
    current = harness;
    Date.now = () => originTime + harness.now * 1_000;
    assert.deepEqual(await harness.durable(), states[0].durable);
    for (const state of states.slice(1)) {
      const before = await harness.durable();
      const priorRequests = { ...harness.requests };
      const priorActivations = harness.activations;
      harness.fault = state.fault;
      harness.operation = state.operation;
      let result;
      switch (state.operation) {
        case "resume":
          result = await outcome(() => harness.auth.handle("resume"));
          if (before.pending !== "activation" || !state.bindingMatches) {
            assert.deepEqual(harness.requests, priorRequests);
            assert.equal(harness.activations, priorActivations);
          }
          break;
        case "cancel":
        case "disconnect":
          result = await outcome(() =>
            harness.auth.cancel({
              disconnect: state.operation === "disconnect",
            }),
          );
          break;
        case "race":
          result = await race(harness, state.fault);
          meaningful.add(`race/${state.fault}`);
          break;
        case "restart":
          harness.auth = harness.makeAuth();
          result = "none";
          break;
        case "tick":
          harness.now = state.now;
          result = "none";
          break;
        default:
          assert.fail(`unknown operation ${state.operation}`);
      }
      if (serverFailure) throw serverFailure;
      if (
        state.fault === "none" &&
        (result === "authenticated" ||
          (state.targeted && result === "cancelled"))
      ) {
        meaningful.add(`${state.operation}/none`);
      }
      assert.equal(
        result,
        state.result,
        `${file} step ${steps}: ${state.operation}/${state.fault}`,
      );
      assert.deepEqual(
        await harness.durable(),
        state.durable,
        `${file} step ${steps}: ${state.operation}/${state.fault}`,
      );
      exercised.add(`${state.operation}/${state.fault}`);
      steps++;
    }
    await harness.close();
  }
  for (const fault of [
    "none",
    "ack-before",
    "ack-after",
    "ack-invalid",
    "activate-before",
    "activate-after",
    "clear-before",
    "clear-after",
  ]) {
    assert(
      meaningful.has(`resume/${fault}`),
      `missing meaningful resume/${fault}`,
    );
  }
  for (const operation of ["cancel", "disconnect"]) {
    for (const fault of [
      "none",
      "journal-before",
      "journal-after",
      "revoke-before",
      "revoke-after",
      "active-before",
      "active-after",
      "clear-before",
      "clear-after",
    ]) {
      assert(
        meaningful.has(`${operation}/${fault}`),
        `missing meaningful ${operation}/${fault}`,
      );
    }
  }
  for (const cut of ["read", "ack", "activate", "activate-commit", "clear"]) {
    assert(meaningful.has(`race/${cut}`), `missing cancellation cut ${cut}`);
  }
  const digest = createHash("sha256")
    .update(await readFile(path.join(root, model)))
    .digest("hex");
  const evidence = {
    model,
    sha256: digest,
    seed: 20261108,
    traces: files.length,
    steps,
    exercised: [...exercised].sort(),
    meaningful: [...meaningful].sort(),
    storage: "real private files with atomic receipt replacement",
    transport: "real loopback HTTP, including lost replies after effects",
    limitations:
      "No issued credential replacement, initial challenge/PKCE, verified-owner callback, cryptographic verification or multi-process file coordination.",
  };
  await writeFile(
    path.join(directory, "evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(
    `Native enrollment conformance passed: ${files.length} traces, ${steps} transitions, all 31 effect/cancellation cases.`,
  );
  console.log(`Evidence: ${path.join(directory, "evidence.json")}`);
} finally {
  Date.now = originalNow;
  current = null;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
