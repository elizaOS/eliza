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

// The orchestrator-version-source contract only applies to wrapper repos that
// disable the local eliza workspace before installing published @elizaos/*.
// Pure elizaOS upstream checkouts run the contract directly against their own
// workspace and don't need the submodule init / version-pin / fallback-install
// dance — `scripts/disable-local-eliza-workspace.mjs` is the wrapper-shape
// marker. Skip when absent.
const wrapperShape = fs.existsSync(
  path.join(repoRoot, "scripts", "disable-local-eliza-workspace.mjs"),
);

function workflowText() {
  return fs.readFileSync(workflowPath, "utf8");
}

describe("electrobun release workflow drift", () => {
  it.skipIf(!workflowOnDisk || !wrapperShape)(
    "pins the orchestrator version source before disabling local workspaces and installs fallback deps after",
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
      const fallbackInstallIndex = workflow.indexOf(
        "- name: Install published-workspace fallback dependencies",
      );

      expect(elizaInitIndex).toBeGreaterThanOrEqual(0);
      expect(versionSourceIndex).toBeGreaterThanOrEqual(0);
      expect(disableIndex).toBeGreaterThanOrEqual(0);
      expect(fallbackInstallIndex).toBeGreaterThanOrEqual(0);
      expect(elizaInitIndex).toBeLessThan(versionSourceIndex);
      expect(versionSourceIndex).toBeLessThan(disableIndex);
      expect(fallbackInstallIndex).toBeGreaterThan(disableIndex);
      expect(workflow).toContain("git submodule update --init --depth=1 eliza");
      expect(workflow).toContain(
        "git -C eliza submodule update --init plugins/plugin-agent-orchestrator",
      );
    },
  );
});
