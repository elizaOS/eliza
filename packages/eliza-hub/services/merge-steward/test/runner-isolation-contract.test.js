import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const RUNNER_COMPOSE_PATH = new URL(
  "../../../deployment/hetzner-staging/compose.actions-runner.yml",
  import.meta.url,
);
const RUNNER_CONFIG_PATH = new URL(
  "../../../deployment/hetzner-staging/runner/config.example.yml",
  import.meta.url,
);
const REGISTER_SCRIPT_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/register-actions-runner.sh",
  import.meta.url,
);
const CHECK_SCRIPT_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/check-actions-runner.sh",
  import.meta.url,
);
const EVIDENCE_SCRIPT_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/runner-evidence.sh",
  import.meta.url,
);
const SMOKE_EVIDENCE_SCRIPT_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/runner-smoke-evidence.mjs",
  import.meta.url,
);
const RUNNER_SMOKE_WORKFLOW_PATH = new URL(
  "../../../.forgejo/workflows/runner-smoke.yml",
  import.meta.url,
);
const HOST_REGISTER_SCRIPT_PATH = new URL(
  "../../../scripts/register-host-runner.sh",
  import.meta.url,
);
const HOST_START_SCRIPT_PATH = new URL(
  "../../../scripts/start-host-runner.sh",
  import.meta.url,
);

describe("staging runner isolation contract", () => {
  it("keeps the host Docker socket out of the staging runner pool", async () => {
    const files = {
      "compose.actions-runner.yml": await readFile(RUNNER_COMPOSE_PATH, "utf8"),
      "runner/config.example.yml": await readFile(RUNNER_CONFIG_PATH, "utf8"),
    };
    for (const [name, content] of Object.entries(files)) {
      assert.doesNotMatch(
        content,
        /\/var\/run\/docker\.sock/,
        `${name} must not reference the host Docker socket`,
      );
    }
  });

  it("keeps staging runner labels on Docker executors instead of host executors", async () => {
    const config = await readFile(RUNNER_CONFIG_PATH, "utf8");

    assert.match(config, /capacity:\s*1/);
    assert.match(config, /docker:docker:\/\/node:24-bookworm/);
    assert.match(config, /node-24:docker:\/\/node:24-bookworm/);
    assert.match(config, /ubuntu-latest:docker:\/\/node:24-bookworm/);
    assert.doesNotMatch(config, /^\s*-\s*[A-Za-z0-9_-]+:host\s*$/m);
  });

  it("keeps Docker-in-Docker isolated behind the runner compose overlay", async () => {
    const compose = await readFile(RUNNER_COMPOSE_PATH, "utf8");

    assert.match(compose, /actions-dind:/);
    assert.match(compose, /privileged:\s*true/);
    assert.match(compose, /tcp:\/\/actions-dind:2375/);
    assert.match(compose, /internal:\s*true/);
    assert.doesNotMatch(compose, /ports:/);
  });

  it("keeps registration token handling in the private environment path", async () => {
    const registerScript = await readFile(REGISTER_SCRIPT_PATH, "utf8");
    const checkScript = await readFile(CHECK_SCRIPT_PATH, "utf8");

    assert.match(registerScript, /FORGEJO_RUNNER_REGISTRATION_TOKEN/);
    assert.match(registerScript, /ENV_FILE/);
    assert.doesNotMatch(registerScript, /set -x/);
    assert.match(checkScript, /host Docker socket is not exposed/);
    assert.match(checkScript, /runner labels avoid host executors/);
  });

  it("generates private runner evidence only after live checks and attestations", async () => {
    const script = await readFile(EVIDENCE_SCRIPT_PATH, "utf8");

    assert.match(script, /check-actions-runner\.sh/);
    assert.match(script, /runner-smoke-evidence\.mjs/);
    assert.match(script, /RUNNER_SMOKE_EVIDENCE_FILE/);
    assert.match(script, /RUNNER_TRUSTED_SMOKE_WORKFLOW_PASSED/);
    assert.match(script, /RUNNER_EGRESS_REVIEWED/);
    assert.match(script, /RUNNER_SECRET_EXPOSURE_REVIEWED/);
    assert.match(script, /RUNNER_EVIDENCE_OUTPUT/);
    assert.match(script, /RUNNER_ISOLATION_AUDIT_OUTPUT/);
    assert.match(script, /RUNNER_PRODUCTION_EVIDENCE_OUTPUT/);
    assert.match(script, /smokeEvidence/);
    assert.match(script, /auditEvidence/);
    assert.match(script, /runner-isolation/);
    assert.match(script, /umask 077/);
    assert.doesNotMatch(script, /FORGEJO_RUNNER_REGISTRATION_TOKEN/);
  });

  it("keeps the trusted runner smoke workflow explicitly dispatched, isolated, and secret-free", async () => {
    const workflow = await readFile(RUNNER_SMOKE_WORKFLOW_PATH, "utf8");
    const helper = await readFile(SMOKE_EVIDENCE_SCRIPT_PATH, "utf8");

    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /runs-on:\s*docker/);
    assert.match(workflow, /timeout-minutes:\s*5/);
    assert.match(workflow, /test ! -e \/var\/run\/docker\.sock/);
    assert.match(workflow, /runner-smoke:ok/);
    assert.doesNotMatch(workflow, /pull_request:/);
    assert.doesNotMatch(workflow, /secrets\./);
    assert.doesNotMatch(workflow, /actions\/checkout/);
    assert.match(helper, /actions\/workflows/);
    assert.match(helper, /dispatches/);
    assert.match(helper, /actions\/runs/);
    assert.match(helper, /RUNNER_SMOKE_DISPATCH/);
    assert.doesNotMatch(helper, /FORGEJO_RUNNER_REGISTRATION_TOKEN/);
  });

  it("requires explicit local-only acknowledgement before host runner scripts can run", async () => {
    const [registerScript, startScript] = await Promise.all([
      readFile(HOST_REGISTER_SCRIPT_PATH, "utf8"),
      readFile(HOST_START_SCRIPT_PATH, "utf8"),
    ]);

    for (const script of [registerScript, startScript]) {
      assert.match(script, /ALLOW_LOCAL_HOST_RUNNER/);
      assert.match(script, /host runner is local-only/);
      assert.match(script, /exit 2/);
    }
  });
});

async function _readAllRunnerFiles() {
  const [compose, config, registerScript, checkScript] = await Promise.all([
    readFile(RUNNER_COMPOSE_PATH, "utf8"),
    readFile(RUNNER_CONFIG_PATH, "utf8"),
    readFile(REGISTER_SCRIPT_PATH, "utf8"),
    readFile(CHECK_SCRIPT_PATH, "utf8"),
  ]);
  return {
    "compose.actions-runner.yml": compose,
    "runner/config.example.yml": config,
    "register-actions-runner.sh": registerScript,
    "check-actions-runner.sh": checkScript,
  };
}
