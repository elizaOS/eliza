/**
 * Pins quality.yml's defensive child-local push guard while Develop Full
 * serializes complete graphs and manual diagnostics remain independent.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowPath = join(repoRoot, ".github", "workflows", "quality.yml");

describe("quality.yml concurrency contract", () => {
  const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8")) as {
    concurrency?: { group?: string; "cancel-in-progress"?: string | boolean };
  };

  test("keeps a stable push-context backstop group", () => {
    const group = workflow.concurrency?.group;
    expect(group).toStartWith("quality-");
    expect(group).toContain("|| github.ref");
    expect(group).not.toContain("pull_request");
    // An unconditional run_id fallback would give every push a unique group
    // and re-open the unbounded queue from #14069. run_id may appear only
    // behind an explicit workflow_dispatch guard, so a manual health read is
    // not parked behind the child group used by called push-context runs.
    const dispatchGuard =
      "github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id)";
    const withoutDispatchGuard = String(group).replace(dispatchGuard, "");
    expect(withoutDispatchGuard).not.toContain("run_id");
  });

  test("cancels only overlapping push-context child runs", () => {
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(
      `\${{ github.event_name == 'push' }}`,
    );
  });
});
