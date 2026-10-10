/**
 * Deterministic contract tests for exact-SHA latency evidence validation and
 * private raw Worker Tail lifecycle; HTTP tests use only a local loopback server.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractBoundedChildFailure,
  InferenceAuthPhaseFailure,
  parseCertificationArgs,
  requireAuthSecrets,
  requirePairedSecrets,
  requireTraceSecrets,
  retainAuthFailure,
  runTraces,
  validateAuthEvidence,
  validatePairedEvidence,
  verifyExactDeployment,
  withPrivateTailDirectory,
  withPrivateTraceDirectory,
} from "./cloud-latency-certification.ts";

import {
  AuthProbeHttpStatusError,
  probeAuthSample,
} from "./inference-auth-latency.ts";

const SHA = "a".repeat(40);

test("actual HTTP auth denial retains only a closed phase and status receipt", async () => {
  const privateKey = "fixture-key-must-not-be-retained";
  const privateToken = "fixture-token-must-not-be-retained";
  const privateBody = "private upstream response must not be retained";
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/v1/chat/completions");
    assert.equal(request.headers["x-api-key"], privateKey);
    response.writeHead(403, { "x-private-header": privateToken });
    response.end(privateBody);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const directory = await mkdtemp(join(tmpdir(), "auth-phase-receipt-"));
  try {
    let actualFailure: unknown;
    try {
      await probeAuthSample({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        apiKey: privateKey,
        probeToken: privateToken,
        deploySha: SHA,
        phase: "prime",
        sequence: 0,
        timeoutMs: 5_000,
      });
    } catch (cause) {
      actualFailure = cause;
    }
    assert.ok(actualFailure instanceof AuthProbeHttpStatusError);
    const failure = new InferenceAuthPhaseFailure(
      "tail_readiness",
      actualFailure,
    );
    await retainAuthFailure(directory, failure);
    const receipt = await readFile(
      join(directory, "auth-failure.json"),
      "utf8",
    );
    assert.deepEqual(JSON.parse(receipt), {
      kind: "inference_auth_phase_failure",
      phase: "tail_readiness",
      category: "unexpected_http_status",
      httpStatus: 403,
    });
    assert.equal(failure.cause, actualFailure);
    for (const privateValue of [
      privateKey,
      privateToken,
      privateBody,
      actualFailure.message,
    ]) {
      assert.ok(!receipt.includes(privateValue));
    }
    assert.equal(
      (await stat(join(directory, "auth-failure.json"))).mode & 0o777,
      0o600,
    );
    await assert.rejects(() => retainAuthFailure(directory, failure), {
      code: "EEXIST",
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown and teardown failures retain causes privately without publishing them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "auth-phase-receipt-"));
  const original = new Error("private original request credentials");
  const teardown = new Error("private Tail bytes");
  const aggregate = new AggregateError([original, teardown]);
  const failure = new InferenceAuthPhaseFailure("tail_teardown", aggregate);
  try {
    await retainAuthFailure(directory, failure);
    const receipt = await readFile(
      join(directory, "auth-failure.json"),
      "utf8",
    );
    assert.deepEqual(JSON.parse(receipt), {
      kind: "inference_auth_phase_failure",
      phase: "tail_teardown",
      category: "phase_failed",
      httpStatus: null,
    });
    assert.deepEqual(failure.cause.errors, [original, teardown]);
    assert.ok(!receipt.includes(original.message));
    assert.ok(!receipt.includes(teardown.message));
    await rm(join(directory, "auth-failure.json"));
    await retainAuthFailure(directory, original);
    assert.equal(
      JSON.parse(await readFile(join(directory, "auth-failure.json"), "utf8"))
        .phase,
      "unknown",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("intentional targeted placement admits remote headers without relaxing proof or identity checks", () => {
  const policy = { mode: "targeted", region: "gcp:us-west2", deploySha: SHA };
  const records = Array.from({ length: 44 }, (_, index) =>
    pairedRecord(index, { headers: { "cf-placement": "remote-LAX" } }),
  );
  assert.equal(
    validatePairedEvidence(jsonl(records), SHA, SHA, policy).counts.gateway,
    22,
  );
  assert.throws(
    () => validatePairedEvidence(jsonl(records), SHA),
    /remote Worker placement/,
  );
  assert.throws(
    () =>
      validatePairedEvidence(jsonl(records), SHA, SHA, {
        ...policy,
        deploySha: "b".repeat(40),
      }),
    /placement policy/,
  );
  assert.throws(
    () => validatePairedEvidence(jsonl(records), SHA, SHA, { mode: "smart" }),
    /placement policy/,
  );
  for (const change of [
    { temperature: 1 },
    { temperature: undefined },
    { proofMatched: false },
    { transportOk: false },
    { ci: { sha: "b".repeat(40), gatewayDeploySha: SHA } },
    { headers: { "cf-placement": "banana" } },
    { headers: { "cf-placement": "remote-XX" } },
  ]) {
    const invalid = records.map((record, index) =>
      index === 1 ? { ...record, ...change } : record,
    );
    assert.throws(() =>
      validatePairedEvidence(jsonl(invalid), SHA, SHA, policy),
    );
  }
  const missingLocation = records.map((record) => ({
    ...record,
    headers: { "cf-placement": "remote-" },
  }));
  const result = validatePairedEvidence(
    jsonl(missingLocation),
    SHA,
    SHA,
    policy,
  );
  assert.deepEqual(result.placementLocations, { reported: 0, unavailable: 22 });
  assert.equal(result.records[1].headers["cf-placement"], "remote-");
  assert.throws(
    () => validatePairedEvidence(jsonl(missingLocation), SHA),
    /invalid Worker placement/,
  );
});

function pairedRecord(index, overrides = {}) {
  return {
    schemaVersion: 1,
    target: index % 2 === 0 ? "direct" : "gateway",
    ok: true,
    transportOk: true,
    proofMatched: true,
    temperature: 0,
    ci: { sha: SHA, gatewayDeploySha: SHA },
    headers: index % 2 === 0 ? {} : { "cf-placement": "local-ORD" },
    ...overrides,
  };
}

function authTrace(index) {
  const suffix = index.toString(16).padStart(12, "0");
  return `11111111111141118111${suffix}`;
}

function authEvidence(runSuspended = false) {
  const records = [
    { kind: "deployment", deploySha: SHA, environment: "staging" },
  ];
  for (let index = 0; index < 30; index++) {
    records.push({
      kind: "sample",
      deploySha: SHA,
      phase: "hit",
      sequence: index,
      traceId: authTrace(index),
      status: 400,
      auth: { read: "hit", result: "authorized_cache" },
    });
  }
  for (let index = 0; index < 10; index++) {
    records.push({
      kind: "sample",
      deploySha: SHA,
      phase: "miss",
      sequence: index,
      traceId: authTrace(30 + index),
      status: 400,
      auth: {
        read: "miss",
        authoritative: "authorized",
        write: "deferred",
        result: "authorized_origin",
      },
    });
  }
  records.push(
    {
      kind: "guard",
      deploySha: SHA,
      guard: "invalid_key",
      traceId: authTrace(40),
      status: 401,
    },
    {
      kind: "guard",
      deploySha: SHA,
      guard: "forged_probe",
      traceId: authTrace(41),
      status: 400,
    },
    ...(runSuspended
      ? [
          {
            kind: "guard",
            deploySha: SHA,
            guard: "suspended_key",
            traceId: authTrace(42),
            status: 403,
          },
        ]
      : []),
    {
      kind: "summary",
      deploySha: SHA,
      counts: { hit: 30, miss: 10 },
      suspendedGuard: runSuspended ? "observed" : "not_requested",
    },
  );
  return records;
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

test("parseCertificationArgs requires an exact SHA and explicit output directory", () => {
  assert.deepEqual(
    parseCertificationArgs([
      "--deploy-sha",
      SHA,
      "--output-dir",
      "artifacts/cert",
      "--auth",
    ]),
    {
      deploySha: SHA,
      environment: "staging",
      probeCase: "qwen-3.8-27b@high@max",
      outputDir: join(process.cwd(), "artifacts/cert"),
      acknowledgedContractDigest: "",
      runAuth: true,
      runSuspended: false,
    },
  );
  assert.throws(
    () =>
      parseCertificationArgs([
        "--deploy-sha",
        "develop",
        "--output-dir",
        "artifacts/cert",
      ]),
    /lowercase 40-character commit/,
  );
  assert.throws(
    () =>
      parseCertificationArgs([
        "--deploy-sha",
        SHA,
        "--output-dir",
        "artifacts/cert",
        "--suspended",
      ]),
    /requires --auth/,
  );
});

test("protected secret gates fail closed without exposing values", () => {
  const configured = {
    CEREBRAS_API_KEY: "direct-private",
    ELIZAOS_CLOUD_API_KEY: "gateway-private",
    ELIZA_STAGING_SUSPENDED_API_KEY: "suspended-private",
    INFERENCE_AUTH_PROBE_TOKEN: "probe-private",
    CLOUDFLARE_API_TOKEN: "cloudflare-private",
    CLOUDFLARE_ACCOUNT_ID: "account-private",
  };
  assert.equal(requirePairedSecrets(configured).directApiKey, "direct-private");
  assert.equal(requireAuthSecrets(configured).probeToken, "probe-private");
  assert.equal(
    requireAuthSecrets(
      { ...configured, ELIZA_STAGING_SUSPENDED_API_KEY: " " },
      false,
    ).probeToken,
    "probe-private",
  );
  assert.throws(
    () =>
      requireAuthSecrets(
        { ...configured, ELIZA_STAGING_SUSPENDED_API_KEY: " " },
        true,
      ),
    /ELIZA_STAGING_SUSPENDED_API_KEY/,
  );
  const failure = (() => {
    try {
      requireAuthSecrets({ ...configured, INFERENCE_AUTH_PROBE_TOKEN: " " });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.match(failure.message, /INFERENCE_AUTH_PROBE_TOKEN/);
  assert.equal(failure.message.includes("probe-private"), false);
});

test("child failure diagnostics retain only a bounded trusted category", () => {
  assert.equal(
    extractBoundedChildFailure(
      "transport details\n[inference-auth-latency] Auth probe returned HTTP 503\n",
      "inference-auth-latency",
    ),
    "[inference-auth-latency] Auth probe returned HTTP 503",
  );
  assert.equal(
    extractBoundedChildFailure(
      "[inference-auth-latency] leaked_secret=do-not-log\n",
      "inference-auth-latency",
    ),
    null,
  );
  assert.equal(
    extractBoundedChildFailure(
      `[inference-auth-latency] ${"x".repeat(300)}\n`,
      "inference-auth-latency",
    ),
    null,
  );
});

test("verifyExactDeployment accepts only the requested staging commit", async () => {
  assert.deepEqual(
    await verifyExactDeployment(SHA, async () =>
      Response.json({ status: "ok", environment: "staging", commit: SHA }),
    ),
    { kind: "deployment", deploySha: SHA, environment: "staging" },
  );
  await assert.rejects(
    verifyExactDeployment(SHA, async () =>
      Response.json({
        status: "ok",
        environment: "staging",
        commit: "b".repeat(40),
      }),
    ),
    /expected commit/,
  );
  await assert.rejects(
    verifyExactDeployment(SHA, async () =>
      Response.json({ status: "ok", environment: "production", commit: SHA }),
    ),
    /wrong environment/,
  );
});

test("paired certification requires exactly 44 balanced successful proofs", () => {
  const records = Array.from({ length: 44 }, (_, index) => pairedRecord(index));
  assert.deepEqual(validatePairedEvidence(jsonl(records), SHA).counts, {
    direct: 22,
    gateway: 22,
  });
  assert.throws(
    () =>
      validatePairedEvidence(
        jsonl(
          records.map((record, index) =>
            index === 7 ? { ...record, proofMatched: false } : record,
          ),
        ),
        SHA,
      ),
    /failed proof/,
  );
  assert.throws(
    () => validatePairedEvidence(jsonl(records.slice(1)), SHA),
    /44 records/,
  );
  assert.throws(
    () =>
      validatePairedEvidence(
        jsonl(
          records.map((record, index) =>
            index === 1
              ? { ...record, headers: { "cf-placement": "remote-FRA" } }
              : record,
          ),
        ),
        SHA,
      ),
    /remote Worker placement/,
  );
  assert.doesNotThrow(() =>
    validatePairedEvidence(
      jsonl(
        records.map((record) =>
          record.target === "gateway" ? { ...record, headers: {} } : record,
        ),
      ),
      SHA,
    ),
  );
  for (const placement of [
    "REMOTE-FRA",
    "remote",
    "banana",
    42,
    null,
    {},
    [],
  ]) {
    assert.throws(
      () =>
        validatePairedEvidence(
          jsonl(
            records.map((record, index) =>
              index === 1
                ? { ...record, headers: { "cf-placement": placement } }
                : record,
            ),
          ),
          SHA,
        ),
      /invalid Worker placement/,
    );
  }
});

test("paired evidence keeps trusted verifier and deployed identities distinct", () => {
  const sourceSha = "b".repeat(40);
  const records = Array.from({ length: 44 }, (_, index) =>
    pairedRecord(index, {
      ci: { sha: sourceSha, gatewayDeploySha: SHA },
    }),
  );
  assert.equal(
    validatePairedEvidence(jsonl(records), SHA, sourceSha).records.length,
    44,
  );
  for (const ci of [
    { sha: SHA, gatewayDeploySha: SHA },
    { sha: sourceSha, gatewayDeploySha: sourceSha },
    { sha: sourceSha },
  ]) {
    const invalid = records.map((record, index) =>
      index === 0 ? { ...record, ci } : record,
    );
    assert.throws(
      () => validatePairedEvidence(jsonl(invalid), SHA, sourceSha),
      /source and deployment SHAs/,
    );
  }
});

test("auth certification separates required guards from optional suspended standing", () => {
  const records = authEvidence(false);
  const result = validateAuthEvidence(jsonl(records), SHA);
  assert.equal(result.records.length, 44);
  assert.equal(result.traceIds.length, 42);
  assert.throws(
    () => validateAuthEvidence(jsonl(records), SHA, true),
    /45 records/,
  );

  const suspendedRecords = authEvidence(true);
  const suspended = validateAuthEvidence(jsonl(suspendedRecords), SHA, true);
  assert.equal(suspended.records.length, 45);
  assert.equal(suspended.traceIds.length, 43);
  assert.throws(
    () =>
      validateAuthEvidence(
        jsonl(
          suspendedRecords.map((record) =>
            record.guard === "suspended_key"
              ? { ...record, status: 401 }
              : record,
          ),
        ),
        SHA,
        true,
      ),
    /suspended guard evidence/,
  );
  assert.throws(
    () =>
      validateAuthEvidence(
        jsonl(
          records.map((record) =>
            record.kind === "summary"
              ? { ...record, suspendedGuard: "observed" }
              : record,
          ),
        ),
        SHA,
        false,
      ),
    /misstates the suspended guard/,
  );
});

test("private Tail directory is mode 0700 and deleted after success", async () => {
  const root = await mkdtemp(join(tmpdir(), "eliza-tail-test-root-"));
  let observedDirectory = "";
  try {
    const value = await withPrivateTailDirectory(async (directory) => {
      observedDirectory = directory;
      const metadata = await stat(directory);
      assert.equal(metadata.mode & 0o777, 0o700);
      return "done";
    }, root);
    assert.equal(value, "done");
    assert.equal(existsSync(observedDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private Tail directory is deleted when capture fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "eliza-tail-test-root-"));
  let observedDirectory = "";
  try {
    await assert.rejects(
      withPrivateTailDirectory(async (directory) => {
        observedDirectory = directory;
        throw new Error("capture failed");
      }, root),
      /capture failed/,
    );
    assert.equal(existsSync(observedDirectory), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace capture removes private raw bytes on success and failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "eliza-trace-cleanup-test-"));
  try {
    for (const fail of [false, true]) {
      let observedDirectory;
      const capture = withPrivateTraceDirectory(async (directory) => {
        observedDirectory = directory;
        assert.equal((await stat(directory)).mode & 0o777, 0o700);
        await writeFile(join(directory, "raw.json"), '{"private":"sentinel"}', {
          mode: 0o600,
        });
        if (fail) throw new Error("trace boundary failed");
        return { status: "inconclusive_sampling" };
      }, root);
      if (fail) await assert.rejects(capture, /trace boundary failed/);
      else assert.equal((await capture).status, "inconclusive_sampling");
      assert.equal(existsSync(observedDirectory), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace credentials fail closed without exposing configured values", () => {
  const configured = {
    CLOUDFLARE_API_TOKEN: "private-trace-token",
    CLOUDFLARE_ACCOUNT_ID: "private-account",
  };
  assert.equal(
    requireTraceSecrets(configured).cloudflareApiToken,
    configured.CLOUDFLARE_API_TOKEN,
  );
  for (const missing of Object.keys(configured)) {
    assert.throws(
      () => requireTraceSecrets({ ...configured, [missing]: " " }),
      (error) => {
        assert.ok(error.message.includes(missing));
        assert.ok(!error.message.includes("private-trace-token"));
        assert.ok(!error.message.includes("private-account"));
        return true;
      },
    );
  }
});

test("trace API denial survives private cleanup without retaining upstream secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "eliza-trace-denial-test-"));
  const outputDir = join(root, "output");
  const privateRoot = join(root, "capture");
  await mkdir(outputDir);
  await mkdir(privateRoot);
  const secret = "upstream-private-value";
  const options = {
    deploySha: SHA,
    outputDir,
    env: {
      RUNNER_TEMP: privateRoot,
      CLOUDFLARE_API_TOKEN: secret,
      CLOUDFLARE_ACCOUNT_ID: secret,
    },
    pairedRecords: Array.from({ length: 22 }, (_, index) => ({
      target: "gateway",
      sequence: index + 1,
      observedAt: new Date(1_780_000_000_000 + index * 500).toISOString(),
      headers: {
        "cf-ray": `${(index + 1).toString(16).padStart(16, "0")}-ORD`,
      },
    })),
  };
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        success: false,
        errors: [
          {
            code: 10000,
            message: secret,
            documentation_url: `https://example.invalid/${secret}`,
          },
        ],
        token: secret,
      }),
      { status: 403 },
    );
  try {
    await assert.rejects(runTraces(options, { fetchImpl }), (error) => {
      assert.equal(error.diagnostic.endpoint, "keys");
      assert.equal(error.diagnostic.httpStatus, 403);
      assert.ok(!error.message.includes(secret));
      return true;
    });
    const artifact = await readFile(
      join(outputDir, "trace-denial.json"),
      "utf8",
    );
    assert.deepEqual(JSON.parse(artifact), {
      kind: "cloudflare_trace_api_denial",
      endpoint: "keys",
      httpStatus: 403,
      errorCodes: [10000],
      documentationUrls: [],
    });
    assert.ok(!artifact.includes(secret));
    assert.deepEqual(await readdir(privateRoot), []);
    assert.equal(existsSync(join(outputDir, "inference-traces.json")), false);
    assert.equal(
      (await stat(join(outputDir, "trace-denial.json"))).mode & 0o777,
      0o600,
    );

    await assert.rejects(runTraces(options, { fetchImpl }), (error) => {
      assert.equal(
        error.message,
        "Cloudflare trace denial evidence could not be retained",
      );
      assert.equal(error.cause.errors[0].diagnostic.httpStatus, 403);
      return true;
    });
    assert.equal(
      await readFile(join(outputDir, "trace-denial.json"), "utf8"),
      artifact,
    );
    assert.deepEqual(await readdir(privateRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit probe controls retain the selected reasoning policy and token budget", async () => {
  const { buildOpenAiRequestBody, parseProbeCase } = await import(
    "./chat-latency.ts"
  );
  const defaults = parseCertificationArgs([
    "--deploy-sha",
    SHA,
    "--output-dir",
    "artifacts/cert",
  ]);
  const body = buildOpenAiRequestBody(
    parseProbeCase(defaults.probeCase),
    "synthetic proof",
    "synthetic-cache-key",
  );
  assert.equal(Reflect.get(body, "reasoning_effort"), "high");
  assert.equal(Object.hasOwn(body, "max_tokens"), false);
  assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
  const selected = parseCertificationArgs([
    "--deploy-sha",
    SHA,
    "--output-dir",
    "artifacts/cert",
    "--probe-case",
    "qwen-3.8-27b@high@4096",
  ]);
  const selectedBody = buildOpenAiRequestBody(
    parseProbeCase(selected.probeCase),
    "synthetic proof",
    "synthetic-cache-key",
  );
  assert.equal(Reflect.get(selectedBody, "reasoning_effort"), "high");
  assert.equal(selectedBody.max_tokens, 4096);
  assert.throws(
    () =>
      parseCertificationArgs([
        "--deploy-sha",
        SHA,
        "--output-dir",
        "artifacts/cert",
        "--probe-case",
        "qwen-3.8-27b@none@invalid",
      ]),
    /max_tokens/,
  );
});

test("probe budgets preserve provider maximum and explicit caller limits", async () => {
  const { buildOpenAiRequestBody, parseProbeCase } = await import(
    "./chat-latency.ts"
  );
  for (const value of ["qwen-3.8-27b@high", "qwen-3.8-27b@high@max"]) {
    const probe = parseProbeCase(value);
    assert.equal(probe.maxTokens, null);
    const body = buildOpenAiRequestBody(probe, "proof", undefined);
    assert.equal(Object.hasOwn(body, "max_tokens"), false);
    assert.equal(
      JSON.parse(JSON.stringify({ maxTokens: probe.maxTokens })).maxTokens,
      null,
    );
  }
  for (const cap of [512, 32768, 65536]) {
    const probe = parseProbeCase(`qwen-3.8-27b@none@${cap}`);
    const body = buildOpenAiRequestBody(probe, "proof", undefined);
    assert.equal(body.max_tokens, cap);
    assert.equal(Reflect.get(body, "reasoning_effort"), "none");
  }
  for (const cap of [
    "0",
    "-1",
    "512garbage",
    "1.5",
    "Infinity",
    "9007199254740992",
  ]) {
    assert.throws(
      () => parseProbeCase(`qwen-3.8-27b@high@${cap}`),
      /max_tokens/,
    );
  }
});

test("production certification uses only its fixed endpoint and rejects staging identity", async () => {
  const args = [
    "--deploy-sha",
    SHA,
    "--output-dir",
    "artifacts/cert",
    "--environment",
    "production",
  ];
  assert.equal(parseCertificationArgs(args).environment, "production");
  assert.throws(
    () => parseCertificationArgs([...args, "--auth"]),
    /only in staging/,
  );
  assert.throws(
    () =>
      parseCertificationArgs([
        ...args.slice(0, -1),
        "https://untrusted.invalid",
      ]),
    /Unsupported/,
  );
  let calls = 0;
  const result = await verifyExactDeployment(
    SHA,
    async (url) => {
      calls++;
      assert.equal(url, "https://api.eliza.app/api/health");
      return Response.json({ commit: SHA, environment: "production" });
    },
    "production",
  );
  assert.equal(calls, 1);
  assert.equal(result.environment, "production");
  await assert.rejects(
    verifyExactDeployment(
      SHA,
      async () => Response.json({ commit: SHA, environment: "staging" }),
      "production",
    ),
    /wrong environment/,
  );
  await assert.rejects(
    verifyExactDeployment(
      SHA,
      async () =>
        Response.json({ commit: "b".repeat(40), environment: "production" }),
      "production",
    ),
    /expected commit/,
  );
});
