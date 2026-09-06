/** Exercises the real HEAD-only preflight against controlled HTTP boundaries. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  capabilityFailureCode,
  inspectStandingCapability,
  StandingCapabilityError,
} from "./staging-standing-capability.mjs";

const config = {
  sourceRef: "refs/heads/develop",
  sourceSha: "a".repeat(40),
  expectedDeploySha: "b".repeat(40),
  apiKey: "private-test-credential",
};

function boundary({
  flag = "true",
  role = "moderator",
  healthCommits,
  capabilityCommit,
  status = 200,
} = {}) {
  const requests = [];
  let healthReads = 0;
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      assert.equal(new URL(url).origin, "https://api-staging.eliza.app");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      if (new URL(url).pathname === "/api/health") {
        assert.equal(init.method, "GET");
        assert.equal(init.headers, undefined);
        const commit =
          healthCommits?.[healthReads++] ?? config.expectedDeploySha;
        return Response.json({ commit, environment: "staging" });
      }
      assert.equal(new URL(url).pathname, "/api/v1/admin/moderation");
      assert.equal(init.method, "HEAD");
      assert.equal(init.headers.Authorization, `Bearer ${config.apiKey}`);
      const headers = {};
      if (flag !== null) headers["x-is-admin"] = flag;
      if (role !== null) headers["x-admin-role"] = role;
      if (capabilityCommit) headers["x-deployment-sha"] = capabilityCommit;
      return new Response(null, { status, headers });
    },
  };
}

test("brackets the HEAD request with deployment checks and emits no credential or identity", async () => {
  const http = boundary();
  const result = await inspectStandingCapability(config, {
    fetchImpl: http.fetchImpl,
    now: () => Date.UTC(2026, 8, 5),
  });
  assert.equal(http.requests.length, 3);
  assert.equal(result.isAdmin, true);
  assert.equal(result.role, "moderator");
  assert.equal(result.healthObservedDeploySha, config.expectedDeploySha);
  assert.equal(result.provesModerationMutation, false);
  assert.ok(!JSON.stringify(result).includes(config.apiKey));
  assert.ok(!JSON.stringify(result).includes("Authorization"));
});

test("mixed replicas cannot attribute capability to the surrounding health revision", async () => {
  const http = boundary({
    healthCommits: [config.expectedDeploySha, config.expectedDeploySha],
    capabilityCommit: "c".repeat(40),
  });
  const result = await inspectStandingCapability(config, http);
  assert.equal(result.isAdmin, true);
  assert.equal(result.role, "moderator");
  assert.equal(result.healthObservedDeploySha, config.expectedDeploySha);
  assert.equal(result.capabilityDeployment.status, "unverified");
  assert.equal(
    result.capabilityDeployment.reason,
    "response_revision_not_verified",
  );
  assert.equal(result.deploySha, undefined);
});

test("a false HEAD result does not claim successful authentication", async () => {
  for (const role of [null, ""]) {
    const http = boundary({ flag: "false", role });
    const result = await inspectStandingCapability(config, http);
    assert.equal(result.isAdmin, false);
    assert.equal(result.role, null);
    assert.equal(result.provesAuthentication, false);
  }
});

test("unsafe source or missing credential fails before network access", async () => {
  for (const change of [
    { sourceRef: "refs/heads/main" },
    { sourceSha: "arbitrary" },
    { expectedDeploySha: "arbitrary" },
    { apiKey: " " },
  ]) {
    const http = boundary();
    await assert.rejects(
      inspectStandingCapability({ ...config, ...change }, http),
    );
    assert.equal(http.requests.length, 0);
  }
});

test("deployment mismatch before HEAD prevents credential dispatch", async () => {
  const http = boundary({ healthCommits: ["c".repeat(40)] });
  await assert.rejects(
    inspectStandingCapability(config, http),
    /deployment_mismatch/,
  );
  assert.equal(http.requests.length, 1);
});

test("deployment movement after HEAD invalidates the observation", async () => {
  const http = boundary({
    healthCommits: [config.expectedDeploySha, "c".repeat(40)],
  });
  await assert.rejects(
    inspectStandingCapability(config, http),
    /deployment_mismatch/,
  );
  assert.equal(http.requests.length, 3);
});

test("missing or contradictory role headers cannot fabricate capability", async () => {
  for (const headers of [
    { flag: null, role: null },
    { flag: "true", role: null },
    { flag: "true", role: "private-unknown-value" },
    { flag: "false", role: "super_admin" },
  ]) {
    await assert.rejects(
      inspectStandingCapability(config, boundary(headers)),
      /capability_schema_failure/,
    );
  }
});

test("HTTP and malformed health failures cannot yield evidence", async () => {
  await assert.rejects(
    inspectStandingCapability(config, boundary({ status: 403 })),
    /capability_http_failure/,
  );
  await assert.rejects(
    inspectStandingCapability(config, {
      fetchImpl: async () => new Response("private-body", { status: 503 }),
    }),
    /deployment_http_failure/,
  );
  await assert.rejects(
    inspectStandingCapability(config, {
      fetchImpl: async () => new Response("private-body", { status: 200 }),
    }),
    /deployment_schema_failure/,
  );
});

test("transport and unknown failures expose only bounded local categories", async () => {
  const privateFailure = new Error("private-credential-and-url");
  try {
    await inspectStandingCapability(config, {
      fetchImpl: async () => {
        throw privateFailure;
      },
    });
    assert.fail("transport should reject");
  } catch (error) {
    assert.equal(capabilityFailureCode(error), "transport_failure");
    assert.equal(error.cause, privateFailure);
  }
  assert.equal(capabilityFailureCode(privateFailure), "internal_failure");
  assert.equal(
    capabilityFailureCode(new StandingCapabilityError("private-unknown-code")),
    "internal_failure",
  );
});

test("CLI parsing failures cannot expose supplied private arguments", () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL("./staging-standing-capability.mjs", import.meta.url).pathname,
      "--private-test-argument=value",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "[standing-capability] internal_failure\n");
});
