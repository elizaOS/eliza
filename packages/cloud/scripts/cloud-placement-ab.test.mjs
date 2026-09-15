/**
 * Deterministic contract tests for staging-only placement arm validation,
 * exact-SHA health checks, Cloudflare metadata sanitizing, and summaries.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  fingerprintWorkerBindings,
  parsePlacementAbArgs,
  sanitizePlacementServiceResult,
  summarizePlacementRecords,
  validateStagingArmUrl,
  verifyArmDeployment,
  verifyPlacementWindow,
} from "./cloud-placement-ab.mjs";

const SHA = "a".repeat(40);
const ARMS = [
  {
    arm: "smart",
    baseUrl: "https://api-staging.eliza.app",
    worker: "smart-worker-staging",
  },
  {
    arm: "control",
    baseUrl: "https://control-staging.example.workers.dev",
    worker: "control-worker-staging",
  },
];

function placementWindowFetch({
  controlMode = "absent",
  controlCommit = SHA,
  controlEnvironment = "staging",
} = {}) {
  return async (url) => {
    const target = String(url);
    if (target.endsWith("/api/health")) {
      const control = target.includes("control-staging");
      return Response.json({
        environment: control ? controlEnvironment : "staging",
        commit: control ? controlCommit : SHA,
      });
    }
    const control = target.includes("control-worker-staging");
    return Response.json({
      success: true,
      result: {
        default_environment: {
          script: { placement: { mode: control ? controlMode : "smart" } },
        },
      },
    });
  };
}

test("placement A/B args require two staging origins and an exact SHA", () => {
  assert.deepEqual(
    parsePlacementAbArgs([
      "--deploy-sha",
      SHA,
      "--smart-base-url",
      "https://api-staging.eliza.app",
      "--control-base-url",
      "https://eliza-cloud-api-staging-placement-control.example.workers.dev",
      "--smart-worker",
      "eliza-cloud-api-staging",
      "--control-worker",
      "eliza-cloud-api-staging-placement-control",
      "--output-dir",
      "artifacts/placement",
    ]),
    {
      deploySha: SHA,
      smartBaseUrl: "https://api-staging.eliza.app",
      controlBaseUrl:
        "https://eliza-cloud-api-staging-placement-control.example.workers.dev",
      smartWorker: "eliza-cloud-api-staging",
      controlWorker: "eliza-cloud-api-staging-placement-control",
      outputDir: join(process.cwd(), "artifacts/placement"),
      successPairs: 30,
      maxAttempts: 45,
    },
  );
  assert.throws(
    () => validateStagingArmUrl("https://api.eliza.app", "arm"),
    /staging Worker origin/,
  );
  assert.throws(
    () => validateStagingArmUrl("https://127.0.0.1", "arm"),
    /staging Worker origin/,
  );
  assert.throws(
    () =>
      parsePlacementAbArgs([
        "--deploy-sha",
        SHA,
        "--smart-base-url",
        "https://api-staging.eliza.app",
        "--control-base-url",
        "https://api-staging.eliza.app",
        "--smart-worker",
        "eliza-cloud-api-staging",
        "--control-worker",
        "eliza-cloud-api-staging",
        "--output-dir",
        "artifacts/placement",
      ]),
    /distinct Workers/,
  );
});

test("exact-SHA arm health retains only bounded placement metadata", async () => {
  const result = await verifyArmDeployment(
    { arm: "smart", baseUrl: "https://api-staging.eliza.app", deploySha: SHA },
    async () =>
      Response.json(
        { environment: "staging", commit: SHA, private: "not-retained" },
        { headers: { "cf-placement": "remote-LAX", "cf-ray": "trace-ORD" } },
      ),
  );
  assert.deepEqual(result, {
    arm: "smart",
    deploySha: SHA,
    environment: "staging",
    placement: "remote-LAX",
    colo: "ORD",
  });
  assert.equal(JSON.stringify(result).includes("not-retained"), false);
  await assert.rejects(
    verifyArmDeployment(
      {
        arm: "smart",
        baseUrl: "https://api-staging.eliza.app",
        deploySha: SHA,
      },
      async () =>
        Response.json({ environment: "staging", commit: "b".repeat(40) }),
    ),
    /exact staging commit/,
  );
});

test("post-window attestation stubs reject placement, SHA, and environment drift", async () => {
  const options = {
    arms: ARMS,
    deploySha: SHA,
    accountId: "private-account",
    apiToken: "private-token",
    phase: "Post-window",
  };
  await assert.rejects(
    verifyPlacementWindow(
      options,
      placementWindowFetch({ controlMode: "smart" }),
    ),
    /Post-window control arm must use default placement/,
  );
  await assert.rejects(
    verifyPlacementWindow(
      options,
      placementWindowFetch({ controlCommit: "b".repeat(40) }),
    ),
    /control did not serve the exact staging commit/,
  );
  await assert.rejects(
    verifyPlacementWindow(
      options,
      placementWindowFetch({ controlEnvironment: "production" }),
    ),
    /control did not serve the exact staging commit/,
  );
});

test("Cloudflare placement response is reduced to non-secret decision metadata", () => {
  const result = sanitizePlacementServiceResult("worker-staging", {
    success: true,
    result: {
      default_environment: {
        script: {
          placement: {
            mode: "smart",
            status: "SUCCESS",
            last_analyzed_at: "2026-08-30T17:40:08Z",
          },
          bindings: [{ secret_text: "private" }],
        },
      },
    },
  });
  assert.deepEqual(result, {
    worker: "worker-staging",
    mode: "smart",
    status: "SUCCESS",
    lastAnalyzedAt: "2026-08-30T17:40:08Z",
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("binding readback emits only a structural fingerprint and type counts", () => {
  const payload = {
    success: true,
    result: {
      bindings: [
        { name: "API_KEY", type: "secret_text", text: "private" },
        {
          name: "GATE",
          type: "durable_object_namespace",
          namespace_id: "namespace-1",
          class_name: "Gate",
          script_name: "canonical-worker",
          environment: "staging",
        },
        {
          name: "UPSTREAM",
          type: "service",
          service: "canonical-worker",
          environment: "staging",
          entrypoint: "fetch",
        },
      ],
    },
  };
  const result = fingerprintWorkerBindings("worker-staging", payload);
  assert.equal(result.bindingCount, 3);
  assert.deepEqual(result.types, {
    durable_object_namespace: 1,
    secret_text: 1,
    service: 1,
  });
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("private"), false);
  const changedTarget = structuredClone(payload);
  changedTarget.result.bindings[2].service = "different-worker";
  assert.notEqual(
    result.fingerprint,
    fingerprintWorkerBindings("worker-staging", changedTarget).fingerprint,
  );
});

test("warm summary stratifies arms by observed placement and reports phase percentiles", () => {
  const records = [10, 20, 30].flatMap((duration) => [
    {
      arm: "smart",
      phase: "warm",
      ok: true,
      headers: { "cf-placement": "remote-LAX" },
      responseHeadersMs: duration,
      firstTokenMs: duration + 1,
      totalMs: duration + 2,
      preforward: {
        total: duration,
        auth: duration,
        mid: duration,
        reserve: duration,
        setup: duration,
      },
      serverTiming: { upstream_headers: duration },
    },
    {
      arm: "control",
      phase: "warm",
      ok: true,
      headers: {},
      responseHeadersMs: duration / 2,
      firstTokenMs: duration / 2 + 1,
      totalMs: duration / 2 + 2,
      preforward: { total: duration / 2 },
      serverTiming: { upstream_headers: duration / 2 },
    },
  ]);
  const summary = summarizePlacementRecords(records);
  assert.equal(summary.length, 2);
  assert.deepEqual(
    summary.find((group) => group.arm === "smart")?.preforwardTotalMs,
    { p50: 20, p90: 28, p95: 29 },
  );
  assert.equal(
    summary.find((group) => group.arm === "control")?.placement,
    "absent",
  );
});
