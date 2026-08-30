/**
 * Cloudflare release workflow tests keep callback reconciliation between the
 * final canonical-source check and the staging Worker publication.
 */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const workflowUrl = new URL(
  "../../../.github/workflows/cloud-cf-release.yml",
  import.meta.url,
);

test("staging deploy reconciles Steward immediately before publication", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const deployStep = workflow.slice(
    workflow.indexOf("- name: Deploy to Cloudflare Workers"),
  );
  const recheckIndex = deployStep.lastIndexOf(
    "recheck_canonical_source",
    deployStep.indexOf("bunx wrangler deploy"),
  );
  const reconcileIndex = deployStep.indexOf(
    "cloud:reconcile-steward-email-callback",
  );
  const publishIndex = deployStep.indexOf("bunx wrangler deploy");

  expect(recheckIndex).toBeGreaterThan(-1);
  expect(reconcileIndex).toBeGreaterThan(recheckIndex);
  expect(publishIndex).toBeGreaterThan(reconcileIndex);
  expect(deployStep.slice(recheckIndex, publishIndex)).toContain(
    'if [ "$DEPLOY_ENVIRONMENT" = "staging" ]',
  );
  expect(deployStep).toContain(
    "STEWARD_API_URL: $" + "{{ secrets.STEWARD_API_URL }}",
  );
  expect(deployStep).toContain(
    "STEWARD_PLATFORM_KEYS: $" + "{{ secrets.STEWARD_PLATFORM_KEYS }}",
  );
});
