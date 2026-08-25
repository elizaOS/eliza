/**
 * Pins latest-tip cancellation for the current develop CI graph while manual
 * diagnostics keep independent run-scoped identities.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8")) as {
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: string | boolean;
    queue?: string;
  };
};

describe("ci.yml concurrency contract", () => {
  const concurrency = workflow.concurrency;
  const group = concurrency?.group ?? "";

  test("gives every manual diagnostic an independent run-scoped group", () => {
    expect(group).toContain(
      "github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id)",
    );
  });

  test("uses one stable develop ref group", () => {
    expect(group).toContain("|| github.ref || github.run_id");
    expect(concurrency?.queue).toBeUndefined();
  });

  test("cancels superseded develop pushes", () => {
    expect(concurrency?.["cancel-in-progress"]).toBe(
      `\${{ github.event_name == 'push' }}`,
    );
  });
});
