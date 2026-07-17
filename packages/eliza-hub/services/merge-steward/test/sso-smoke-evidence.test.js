import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = new URL("../../..", import.meta.url);
const SSO_SMOKE_PATH = new URL(
  "deployment/hetzner-staging/scripts/sso-smoke-evidence.mjs",
  REPO_ROOT,
);
const SSO_EVIDENCE_PATH = new URL(
  "deployment/hetzner-staging/scripts/sso-evidence.mjs",
  REPO_ROOT,
);
const RELEASE_GATE_PATH = new URL(
  "deployment/hetzner-staging/scripts/release-gate.sh",
  REPO_ROOT,
);

describe("SSO smoke evidence helper", () => {
  it("writes production-ready structured smoke evidence without printing secrets", async () => {
    const result = await runSsoSmoke({
      env: {
        ...passingSmokeEnv(),
        UNRELATED_SECRET: "do-not-print-this-secret",
      },
    });

    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const artifact = JSON.parse(await readFile(result.output, "utf8"));

    assert.equal(summary.ssoSmokeEvidence.source, result.output);
    assert.deepEqual(summary.ssoSmokeEvidence.failedChecks, []);
    assert.equal(artifact.ssoSmoke.issuerUrl, "https://cloud.eliza.test");
    assert.equal(artifact.ssoSmoke.checkedAt, "2026-07-06T00:05:00.000Z");
    assert.equal(artifact.ssoSmoke.oidcLoginSucceeded, true);
    assert.equal(artifact.ssoSmoke.humanIdentitySmokePassed, true);
    assert.equal(artifact.ssoSmoke.agentIdentitySmokePassed, true);
    assert.equal(artifact.ssoSmoke.serviceIdentitySmokePassed, true);
    assert.equal(artifact.ssoSmoke.publicRegistrationLocked, true);
    assert.equal(artifact.ssoSmoke.nonIssuerRejected, true);
    assert.equal(artifact.ssoSmoke.recoveryAdminLoginSucceeded, true);
    assert.equal(artifact.ssoSmoke.checks.length, 7);
    assert.doesNotMatch(
      result.stdout + result.stderr + JSON.stringify(artifact),
      /do-not-print-this-secret/,
    );
  });

  it("feeds the generated artifact into sso-evidence.mjs", async () => {
    const result = await runSsoSmoke({ env: passingSmokeEnv() });
    assert.equal(result.code, 0, result.stderr);

    const bootstrapJson = await writeTempJson(identityBootstrapEvidence());
    const envFile = await writeTempEnv({
      ...ssoConfigEnv(),
      SSO_EVIDENCE_SMOKE_JSON: result.output,
      SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON: bootstrapJson,
    });
    const evidence = await execFileAsync(
      process.execPath,
      [SSO_EVIDENCE_PATH.pathname, "--env-file", envFile],
      {
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
      },
    );
    const body = JSON.parse(evidence.stdout);

    assert.equal(body.sso.smokeEvidence.source, result.output);
    assert.equal(
      body.sso.smokeEvidence.sha256,
      sha256(await readFile(result.output, "utf8")),
    );
    assert.equal(body.sso.smokeEvidence.checkedAt, "2026-07-06T00:05:00.000Z");
    assert.equal(body.sso.bootstrapEvidence.source, bootstrapJson);
    assert.equal(
      body.sso.bootstrapEvidence.sha256,
      sha256(await readFile(bootstrapJson, "utf8")),
    );
    assert.equal(
      body.sso.bootstrapEvidence.checkedAt,
      "2026-07-06T00:04:00.000Z",
    );
    assert.equal(body.sso.bootstrapEvidence.status, "passed");
    assert.equal(body.sso.bootstrapEvidence.checkCount, 8);
    assert.equal(body.sso.smokeTested, true);
    assert.equal(body.sso.humanIdentitySmokePassed, true);
    assert.equal(body.sso.agentIdentitySmokePassed, true);
    assert.equal(body.sso.serviceIdentitySmokePassed, true);
    assert.equal(body.sso.autoCreateRestrictedToIssuer, true);
    assert.equal(body.sso.recoveryAdminVerified, true);
  });

  it("fails closed when a required smoke check is missing", async () => {
    const result = await runSsoSmoke({
      env: {
        ...passingSmokeEnv(),
        SSO_SMOKE_AGENT_IDENTITY_SMOKE_PASSED: "false",
      },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /agentIdentitySmokePassed/);
    assert.equal(await fileExists(result.output), false);
  });

  it("can retain failed smoke output only when explicitly allowed", async () => {
    const result = await runSsoSmoke({
      args: ["--allow-failed"],
      env: {
        ...passingSmokeEnv(),
        SSO_SMOKE_NON_ISSUER_REJECTED: "false",
      },
    });

    assert.equal(result.code, 0, result.stderr);
    const artifact = JSON.parse(await readFile(result.output, "utf8"));
    assert.equal(artifact.ssoSmoke.nonIssuerRejected, false);
    assert.deepEqual(JSON.parse(result.stdout).ssoSmokeEvidence.failedChecks, [
      "nonIssuerRejected",
    ]);
  });

  it("is included in the release gate syntax checks", async () => {
    const releaseGate = await readFile(RELEASE_GATE_PATH, "utf8");

    assert.match(releaseGate, /sso-smoke-evidence\.mjs/);
    assert.match(
      releaseGate,
      /node --check "\$DEPLOY_DIR\/scripts\/sso-smoke-evidence\.mjs"/,
    );
  });
});

async function runSsoSmoke({ args = [], env = {} } = {}) {
  const dir = await mkdtempInTestRoot("sso-smoke-evidence-");
  const output = path.join(dir, "sso-smoke.json");
  const envFile = await writeTempEnv(env, dir);

  try {
    const result = await execFileAsync(
      process.execPath,
      [
        SSO_SMOKE_PATH.pathname,
        "--env-file",
        envFile,
        "--output",
        output,
        ...args,
      ],
      {
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr, output };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      output,
    };
  }
}

async function writeTempEnv(values, dir = null) {
  const root = dir ?? (await mkdtempInTestRoot("sso-smoke-env-"));
  await mkdir(root, { recursive: true });
  const envFile = path.join(root, ".env");
  await writeFile(
    envFile,
    `${Object.entries(values)
      .map(
        ([key, value]) => `${key}='${String(value).replaceAll("'", "'\\''")}'`,
      )
      .join("\n")}\n`,
    "utf8",
  );
  return envFile;
}

async function writeTempJson(value) {
  const root = await mkdtempInTestRoot("sso-smoke-json-");
  const file = path.join(root, "evidence.json");
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

function passingSmokeEnv() {
  return {
    SSO_SMOKE_ISSUER_URL: "https://cloud.eliza.test",
    SSO_SMOKE_CHECKED_AT: "2026-07-06T00:05:00.000Z",
    SSO_SMOKE_OIDC_LOGIN_SUCCEEDED: "true",
    SSO_SMOKE_HUMAN_IDENTITY_SMOKE_PASSED: "true",
    SSO_SMOKE_AGENT_IDENTITY_SMOKE_PASSED: "true",
    SSO_SMOKE_SERVICE_IDENTITY_SMOKE_PASSED: "true",
    SSO_SMOKE_PUBLIC_REGISTRATION_LOCKED: "true",
    SSO_SMOKE_NON_ISSUER_REJECTED: "true",
    SSO_SMOKE_RECOVERY_ADMIN_LOGIN_SUCCEEDED: "true",
    SSO_SMOKE_HUMAN_SUBJECT: "human:operator",
    SSO_SMOKE_AGENT_SUBJECT: "agent:codex",
    SSO_SMOKE_SERVICE_SUBJECT: "service:merge-steward",
  };
}

function identityBootstrapEvidence() {
  return {
    schema: "https://eliza.hub/schemas/identity-bootstrap-evidence.v1",
    finishedAt: "2026-07-06T00:04:00.000Z",
    status: "passed",
    options: {
      applyBootstrap: false,
      checkDiscovery: true,
      checkStewardToken: true,
    },
    targets: {
      forgejoLocalUrl: "https://git.eliza.test/",
    },
    oidc: {
      authName: "Eliza Cloud",
      issuerUrl: "https://cloud.eliza.test",
    },
    summary: {
      total: 8,
      passed: 8,
      failed: 0,
      warnings: 0,
    },
    checks: [
      { name: "private env validates identity inputs", status: "pass" },
      { name: "compose config renders", status: "pass" },
      { name: "forgejo container is running and healthy", status: "pass" },
      { name: "forgejo CLI responds", status: "pass" },
      { name: "Eliza Cloud discovery document is valid", status: "pass" },
      { name: "local recovery admin exists", status: "pass" },
      {
        name: "Eliza Cloud OIDC auth source config matches env",
        status: "pass",
      },
      { name: "steward token authenticates as steward user", status: "pass" },
    ],
  };
}

function ssoConfigEnv() {
  return {
    ELIZA_CLOUD_OIDC_ISSUER_URL: "https://cloud.eliza.test",
    ELIZA_CLOUD_OIDC_DISCOVERY_URL:
      "https://cloud.eliza.test/.well-known/openid-configuration",
    ELIZA_CLOUD_FORGEJO_CLIENT_ID: "forgejo-client",
    ELIZA_CLOUD_FORGEJO_CLIENT_SECRET: "oidc-client-secret-do-not-print-123456",
    FORGEJO_OIDC_AUTH_NAME: "Eliza Cloud",
    FORGEJO_OIDC_SCOPES: "openid email profile groups",
    FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION: "true",
    FORGEJO_OAUTH2_REGISTER_EMAIL_CONFIRM: "false",
    FORGEJO_OAUTH2_USERNAME: "nickname",
    FORGEJO_OAUTH2_ACCOUNT_LINKING: "login",
    FORGEJO_OIDC_REQUIRED_CLAIM_NAME: "iss",
    FORGEJO_OIDC_REQUIRED_CLAIM_VALUE: "https://cloud.eliza.test",
    FORGEJO_OIDC_GROUP_CLAIM_NAME: "groups",
    FORGEJO_OIDC_ADMIN_GROUP: "eliza-admins",
    FORGEJO_OIDC_RESTRICTED_GROUP: "eliza-agents",
    SSO_EVIDENCE_PUBLIC_REGISTRATION_LOCKED: "true",
  };
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

async function fileExists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}
