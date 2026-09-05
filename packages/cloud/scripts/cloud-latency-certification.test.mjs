/**
 * Deterministic contract tests for exact-SHA latency evidence validation and
 * private raw Worker Tail lifecycle; no network or provider calls are made.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractBoundedChildFailure,
  parseCertificationArgs,
  requireAuthSecrets,
  requirePairedSecrets,
  requireTraceSecrets,
  validateAuthEvidence,
  validatePairedEvidence,
  verifyExactDeployment,
  withPrivateTailDirectory,
  withPrivateTraceDirectory,
} from "./cloud-latency-certification.mjs";

const SHA = "a".repeat(40);

function pairedRecord(index, overrides = {}) {
  return {
    schemaVersion: 1,
    target: index % 2 === 0 ? "direct" : "gateway",
    ok: true,
    transportOk: true,
    proofMatched: true,
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
