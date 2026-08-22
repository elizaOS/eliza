/**
 * Regression guard for the cloud provisioning-host env reconcile loop in
 * `.github/workflows/deploy-eliza-provisioning-worker.yml` (#8756).
 *
 * The deploy workflow is the single source of truth for the provisioning host's
 * `.env.local`. It reconciles a fixed set of keys — including
 * `SANDBOX_REGISTRY_REDIS_URL`, which gates connector inbound routing (#8621),
 * and `SECRETS_MASTER_KEY`, which unwraps Worker-written encrypted agent env
 * vars (#15385) — with **skip-empty-before-delete** semantics: an empty secret
 * value must `continue` (leaving any existing value intact) before the key is
 * added to the atomic replacement plan. Without that ordering, a
 * momentarily-unset GitHub secret would silently blank the live key on the next
 * deploy.
 *
 * Runtime env parsing of `SANDBOX_REGISTRY_REDIS_URL` is covered by
 * `@elizaos/shared`'s `sandbox-registry.test.ts`; this test covers the workflow
 * YAML that injects it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(
  import.meta.dirname,
  "../../../../../.github/workflows/deploy-eliza-provisioning-worker.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

describe("deploy-eliza-provisioning-worker reconcile loop", () => {
  it("reconciles control-plane secrets alongside the headscale keys", () => {
    // These must flow through the same reconcile loop so the box self-heals on
    // every deploy; losing one silently breaks runtime-only control-plane paths.
    expect(workflow).toContain(
      "SANDBOX_REGISTRY_REDIS_URL=$SANDBOX_REGISTRY_REDIS_URL",
    );
    expect(workflow).toContain("SECRETS_MASTER_KEY=$SECRETS_MASTER_KEY");
    expect(workflow).toContain("HEADSCALE_API_KEY=$HEADSCALE_API_KEY");
  });

  it("skips empty values before planning replacement (never blanks a live secret)", () => {
    // append_environment_setting writes the key into ENV_REPLACEMENTS; the
    // serializer later removes every named key before adding its assignment.
    // The non-empty guard must therefore short-circuit before append, and the
    // complete plan must be applied only afterward under the reconcile command.
    const guardIdx = workflow.indexOf('[ -n "$val" ] || continue');
    const appendIdx = workflow.indexOf(
      'append_environment_setting \\\n                "$ENV_REPLACEMENTS" "$ENV_ASSIGNMENTS" "$key" "$val"',
      guardIdx,
    );
    const reconcileIdx = workflow.indexOf(
      '"$NODE_BIN" "$ENV_SERIALIZER" reconcile \\\n              "$ENV_FILE" "$ENV_REPLACEMENTS" "$ENV_ASSIGNMENTS"',
      appendIdx,
    );
    expect(guardIdx).toBeGreaterThan(-1);
    expect(appendIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(appendIdx);
    expect(appendIdx).toBeLessThan(reconcileIdx);
  });
});
