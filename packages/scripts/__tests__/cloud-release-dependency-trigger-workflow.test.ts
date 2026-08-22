/** Ensures mutating Cloud and image publication workflows remain explicit while effect fencing is incomplete. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowNames = [
  "build-agent-image.yml",
  "certification-image.yml",
  "cloud-cf-deploy.yml",
  "deploy-apps-worker.yml",
  "deploy-eliza-provisioning-worker.yml",
];

describe("Cloud publication trigger authority", () => {
  test.each(workflowNames)("%s is manual-only", (name) => {
    const source = readFileSync(
      new URL(`../../../.github/workflows/${name}`, import.meta.url),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as {
      on?: Record<string, unknown>;
    };
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
  });
});
