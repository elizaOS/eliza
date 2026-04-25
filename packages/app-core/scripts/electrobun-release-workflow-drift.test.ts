import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const workflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "test-electrobun-release.yml",
);

const workflowOnDisk = fs.existsSync(workflowPath);

function workflowText() {
  return fs.readFileSync(workflowPath, "utf8");
}

describe("electrobun release workflow drift", () => {
  it.skipIf(!workflowOnDisk)(
    "hydrates the orchestrator plugin before and after disabling local eliza workspaces",
    () => {
      const workflow = workflowText();
      const elizaInitIndex = workflow.indexOf(
        "- name: Initialize eliza submodule for version resolution",
      );
      const versionSourceIndex = workflow.indexOf(
        "- name: Initialize release-check plugin version source",
      );
      const disableIndex = workflow.indexOf(
        "- name: Disable repo-local eliza workspace",
      );
      const initIndex = workflow.indexOf(
        "- name: Initialize release-check plugin checkout",
      );

      expect(elizaInitIndex).toBeGreaterThanOrEqual(0);
      expect(versionSourceIndex).toBeGreaterThanOrEqual(0);
      expect(disableIndex).toBeGreaterThanOrEqual(0);
      expect(initIndex).toBeGreaterThanOrEqual(0);
      expect(elizaInitIndex).toBeLessThan(versionSourceIndex);
      expect(versionSourceIndex).toBeLessThan(disableIndex);
      expect(initIndex).toBeGreaterThan(disableIndex);
      expect(workflow).toContain("git submodule update --init --depth=1 eliza");
      expect(workflow).toContain(
        "git -C eliza submodule update --init plugins/plugin-agent-orchestrator",
      );
    },
  );
});
