import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildRunnerIsolationAudit } from "../src/runner-isolation.js";

const ROOT = new URL("../../..", import.meta.url);
const STAGING_RUNNER_COMPOSE = new URL(
  "deployment/hetzner-staging/compose.actions-runner.yml",
  ROOT,
);
const STAGING_RUNNER_CONFIG = new URL(
  "deployment/hetzner-staging/runner/config.example.yml",
  ROOT,
);

describe("runner isolation audit", () => {
  it("marks isolated runner evidence production-ready when static checks and launch attestations pass", () => {
    const audit = buildRunnerIsolationAudit({
      composeConfig: readFileSync(STAGING_RUNNER_COMPOSE, "utf8"),
      runnerConfig: readFileSync(STAGING_RUNNER_CONFIG, "utf8"),
      registration: { tested: true },
      smoke: { trustedWorkflowPassed: true },
      reviews: { egressReviewed: true, secretExposureReviewed: true },
      now: "2026-07-06T00:00:00.000Z",
    });

    assert.equal(audit.status, "isolated");
    assert.equal(audit.productionReady, true);
    assert.deepEqual(audit.evidence.runner, {
      isolated: true,
      noHostDockerSocket: true,
      noHostLabels: true,
      registrationTested: true,
      trustedSmokeWorkflowPassed: true,
      egressReviewed: true,
      secretExposureReviewed: true,
    });
    assert.equal(audit.requiredActions.length, 0);
    assert.ok(audit.labels.includes("runner-isolation:isolated"));
  });

  it("accepts normalized live runner smoke workflow evidence", () => {
    const audit = buildRunnerIsolationAudit({
      composeConfig: readFileSync(STAGING_RUNNER_COMPOSE, "utf8"),
      runnerConfig: readFileSync(STAGING_RUNNER_CONFIG, "utf8"),
      registration: { tested: true },
      smoke: {
        workflowRun: {
          passed: true,
          workflow: "runner-smoke.yml",
          runId: 42,
          url: "https://git.eliza.test/elizaos/eliza/actions/runs/42",
        },
      },
      reviews: { egressReviewed: true, secretExposureReviewed: true },
    });

    assert.equal(audit.status, "isolated");
    assert.equal(audit.evidence.runner.trustedSmokeWorkflowPassed, true);
  });

  it("keeps checked-in staging runner config blocked until launch attestations are recorded", () => {
    const audit = buildRunnerIsolationAudit({
      composeConfig: readFileSync(STAGING_RUNNER_COMPOSE, "utf8"),
      runnerConfig: readFileSync(STAGING_RUNNER_CONFIG, "utf8"),
    });

    assert.equal(audit.status, "blocked");
    assert.equal(audit.productionReady, false);
    assert.equal(audit.evidence.runner.isolated, true);
    assert.equal(audit.evidence.runner.noHostDockerSocket, true);
    assert.equal(audit.evidence.runner.noHostLabels, true);
    assert.equal(audit.evidence.runner.registrationTested, false);
    assert.equal(audit.evidence.runner.trustedSmokeWorkflowPassed, false);
    assert.ok(
      audit.checks.find((check) => check.name === "runner_registration_tested")
        .status === "fail",
    );
  });

  it("blocks host socket mounts, host labels, published DIND ports, and privileged workflow containers", () => {
    const audit = buildRunnerIsolationAudit({
      composeConfig: `
services:
  actions-dind:
    image: docker:28-dind
    ports:
      - "2375:2375"
  actions-runner:
    environment:
      DOCKER_HOST: unix:///var/run/docker.sock
networks:
  runner: {}
`,
      runnerConfig: `
capacity: 4
labels:
  - ubuntu-latest:host
container:
  docker_host: unix:///var/run/docker.sock
  privileged: true
`,
      registration: { tested: true },
      smoke: { trustedWorkflowPassed: true },
      reviews: { egressReviewed: true, secretExposureReviewed: true },
    });

    assert.equal(audit.status, "blocked");
    assert.equal(audit.productionReady, false);
    assert.equal(audit.evidence.runner.isolated, false);
    assert.equal(audit.evidence.runner.noHostDockerSocket, false);
    assert.equal(audit.evidence.runner.noHostLabels, false);
    assert.ok(audit.snapshots.referencesHostSocket);
    assert.deepEqual(audit.snapshots.hostLabels, ["ubuntu-latest:host"]);
    assert.ok(
      audit.requiredActions.some((action) =>
        action.includes("Remove host Docker socket"),
      ),
    );
  });

  it("uses watch status when static isolation passes but capacity needs review", () => {
    const audit = buildRunnerIsolationAudit({
      composeConfig: readFileSync(STAGING_RUNNER_COMPOSE, "utf8"),
      runnerConfig: readFileSync(STAGING_RUNNER_CONFIG, "utf8").replace(
        "capacity: 1",
        "capacity: 3",
      ),
      registration: { tested: true },
      smoke: { trustedWorkflowPassed: true },
      reviews: { egressReviewed: true, secretExposureReviewed: true },
    });

    assert.equal(audit.status, "watch");
    assert.equal(audit.productionReady, false);
    assert.equal(audit.evidence.runner.isolated, false);
    assert.equal(
      audit.checks.find((check) => check.name === "runner_capacity_limited")
        .status,
      "warn",
    );
  });
});
