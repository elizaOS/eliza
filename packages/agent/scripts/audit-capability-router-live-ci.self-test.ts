/** Exercises real live-workflow admission shells without credentials or network effects. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  liveWorkflowSchema,
  validateCapabilityRouterLiveCi,
} from "./audit-capability-router-live-ci.ts";

const source = readFileSync(".github/workflows/live-smoke.yml", "utf8");
assert.deepEqual(validateCapabilityRouterLiveCi(source), []);
const workflow = liveWorkflowSchema.parse(Bun.YAML.parse(source));
// These workflow predicates use the shared boolean/equality subset of Actions
// expressions and JavaScript. Execute the parsed predicates against dispatch
// inputs so exclusive recovery modes cannot accidentally acquire live effects.
for (const id of [
  "cloud-live-e2e",
  "provider-live-e2e",
  "github-live-artifact-validate",
  "smoke",
]) {
  const condition = workflow.jobs[id]?.if;
  assert.ok(condition);
  const expression = condition.replace(/^\$\{\{|\}\}$/g, "");
  for (const cleanup of [false, true]) {
    for (const diagnostic of ["", "existing-canary"]) {
      const admitted = runInNewContext(expression, {
        inputs: {
          suite: "remote-capabilities",
          cleanup_only: cleanup,
          diagnose_canary_suffix: diagnostic,
        },
        always: () => true,
        cancelled: () => false,
      });
      assert.equal(
        admitted,
        id !== "smoke" && !cleanup && diagnostic === "",
        `${id}: cleanup=${cleanup}, diagnostic=${diagnostic}`,
      );
    }
  }
}
const directory = mkdtempSync(join(tmpdir(), "eliza-live-admission-"));
function run(
  job: string,
  step: string,
  env: Record<string, string>,
): number | null {
  const shell = workflow.jobs[job]?.steps?.find(
    (entry) => entry.name === step,
  )?.run;
  assert.ok(shell, `Missing executable boundary ${job}/${step}`);
  const result = spawnSync("bash", ["-c", shell], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: join(directory, "output"),
      ...env,
    },
  });
  assert.equal(result.error, undefined);
  return result.status;
}
try {
  assert.equal(
    run("cloud-live-e2e", "Check cloud secrets", {
      EVENT_NAME: "workflow_dispatch",
      CAPABILITY_LIVE_REQUIRED: "true",
      ELIZAOS_CLOUD_API_KEY: "",
      ELIZA_REMOTE_CAPABILITY_CLOUD_LIVE_ENABLED: "",
    }),
    1,
  );
  assert.equal(
    run("provider-live-e2e", "Check provider endpoint secrets", {
      EVENT_NAME: "workflow_dispatch",
      LIVE_REQUIRED: "true",
      HOME_URL: "",
      MOBILE_URL: "",
      DESKTOP_URL: "",
    }),
    1,
  );
  assert.equal(
    run("provider-live-e2e", "Check provider endpoint secrets", {
      EVENT_NAME: "workflow_dispatch",
      LIVE_REQUIRED: "true",
      HOME_URL: "https://home.invalid",
      MOBILE_URL: "",
      DESKTOP_URL: "",
    }),
    1,
  );
  assert.equal(
    run("provider-live-e2e", "Check provider endpoint secrets", {
      EVENT_NAME: "workflow_dispatch",
      LIVE_REQUIRED: "true",
      HOME_URL: "https://home.invalid",
      MOBILE_URL: "https://mobile.invalid",
      DESKTOP_URL: "",
    }),
    0,
  );
  for (const enabled of ["", "0", "1"]) {
    assert.equal(
      run("cloud-live-e2e", "Check cloud secrets", {
        ELIZAOS_CLOUD_API_KEY: "test-only-not-a-credential",
        ELIZA_REMOTE_CAPABILITY_CLOUD_LIVE_ENABLED: enabled,
      }),
      enabled === "1" ? 0 : 1,
    );
  }
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    for (const env of [
      { CLOUD_RESULT: result, PROVIDER_RESULT: "success" },
      { CLOUD_RESULT: "success", PROVIDER_RESULT: result },
    ])
      assert.notEqual(
        run("github-live-artifact-validate", "Require live producers", env),
        0,
      );
  }
  assert.equal(
    run("github-live-artifact-validate", "Require live producers", {
      CLOUD_RESULT: "success",
      PROVIDER_RESULT: "success",
    }),
    0,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.stdout.write(
  "Live admission rejects absent credentials and incomplete producers.\n",
);
