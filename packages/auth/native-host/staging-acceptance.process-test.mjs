import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(
  new URL("./staging-acceptance.mjs", import.meta.url),
);
const preload = fileURLToPath(
  new URL("./staging-session-exchange.preload.mjs", import.meta.url),
);
const output = testOutputPath("native-staging-acceptance", "receipt.json");
const fixtureKey = `eliza_${"a".repeat(64)}`;
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const protectedRun = {
  ...process.env,
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "elizaOS/eliza",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/staging",
  GITHUB_SHA: sourceSha,
  ELIZA_NATIVE_STAGING_ACCEPTANCE: "1",
  ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app",
  ELIZAOS_CLOUD_API_KEY: fixtureKey,
};

for (const [context, override] of [
  ["ordinary developer shell", { GITHUB_ACTIONS: "false" }],
  ["fork workflow", { GITHUB_REPOSITORY: "fork/eliza" }],
  ["production ref", { GITHUB_REF: "refs/heads/main" }],
  ["checkout does not match workflow source", { GITHUB_SHA: "0".repeat(40) }],
]) {
  test(`actual fixture process rejects ${context} and emits only a closed receipt`, () => {
    rmSync(output, { force: true });
    const result = spawnSync("node", ["--import", "tsx", script], {
      cwd: repoRoot,
      env: { ...protectedRun, ...override },
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const serialized = readFileSync(output, "utf8");
    assert.deepEqual(JSON.parse(serialized), {
      schema: "elizaos.native-staging-acceptance/v1",
      sourceSha,
      servedSha: null,
      status: "failed",
      failedStep: "admission",
      checks: {},
      providerSignInVerified: false,
      physicalDeviceVerified: false,
    });
    assert.ok(
      !`${result.stdout}${result.stderr}${serialized}`.includes(fixtureKey),
    );
    assert.equal(result.stderr, "");
  });
}

test("actual fixture passes single-use session PKCE against the staging exchange", () => {
  rmSync(output, { force: true });
  const result = spawnSync(
    "node",
    ["--import", "tsx", "--import", preload, script],
    { cwd: repoRoot, env: protectedRun, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
    schema: "elizaos.native-staging-acceptance/v1",
    sourceSha,
    servedSha: sourceSha,
    status: "failed",
    failedStep: "native-grant",
    checks: { protectedAdmission: true, singleUseSessionPkce: true },
    providerSignInVerified: false,
    physicalDeviceVerified: false,
  });
});

for (const [mode, phase, status, code] of [
  ["ineligible", "session-pkce-mint", 403, "subject_not_eligible"],
  ["unexpected", "session-pkce-mint", 503, "unrecognized_response"],
  [
    "exchange-unavailable",
    "session-pkce-exchange",
    503,
    "exchange_unavailable",
  ],
]) {
  test(`actual fixture records ${mode} without response secrets`, () => {
    rmSync(output, { force: true });
    const result = spawnSync(
      "node",
      ["--import", "tsx", "--import", preload, script],
      {
        cwd: repoRoot,
        env: { ...protectedRun, TEST_SESSION_FAILURE_MODE: mode },
        encoding: "utf8",
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const serialized = readFileSync(output, "utf8");
    const receipt = JSON.parse(serialized);
    assert.equal(receipt.failedStep, phase);
    assert.deepEqual(receipt.failedResponse, { status, code });
    assert.equal(receipt.status, "failed");
    const exposed = `${result.stdout}${result.stderr}${serialized}`;
    assert.ok(!exposed.includes(fixtureKey));
    assert.ok(!exposed.includes("private-fixture-token"));
    assert.equal(result.stderr, "");
  });
}
