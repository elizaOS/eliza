/**
 * Regression guard for the cloud provisioning-host env reconcile loop in
 * `.github/workflows/deploy-eliza-provisioning-worker.yml` (#8756).
 *
 * The deploy workflow is the single source of truth for the provisioning host's
 * `.env.local`. It reconciles a fixed set of keys — including
 * `SANDBOX_REGISTRY_REDIS_URL`, which gates connector inbound routing (#8621) —
 * with **skip-empty-before-delete** semantics: an empty secret value must
 * `continue` (leaving any existing value intact) and must never reach the
 * `sed -i "/^KEY=/d"` delete. Without that ordering, a momentarily-unset GitHub
 * secret would silently blank the live key on the next deploy.
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
  it("reconciles SANDBOX_REGISTRY_REDIS_URL alongside the headscale keys", () => {
    // Both must flow through the same reconcile loop so the box self-heals on
    // every deploy. Losing the redis line silently breaks #8621 inbound routing.
    expect(workflow).toContain(
      "SANDBOX_REGISTRY_REDIS_URL=$SANDBOX_REGISTRY_REDIS_URL",
    );
    expect(workflow).toContain("HEADSCALE_API_KEY=$HEADSCALE_API_KEY");
  });

  it("skips empty values before deleting the key (never blanks a live secret)", () => {
    // The guard `[ -n "$val" ] || continue` MUST appear before the
    // `sed -i "/^${key}=/d"` delete, so an empty secret short-circuits the loop
    // body instead of deleting (blanking) the existing key.
    const guardIdx = workflow.indexOf('[ -n "$val" ] || continue');
    const deleteCommand = 'sed -i "/^$' + '{key}=/d"';
    const deleteIdx = workflow.indexOf(deleteCommand);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(deleteIdx);
  });
});
