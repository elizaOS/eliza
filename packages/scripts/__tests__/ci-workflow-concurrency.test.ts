/**
 * Pins the canonical CI event-specific concurrency contract. This deterministic
 * check protects terminal develop health without weakening stale PR or merge
 * queue cancellation and without creating an unbounded push backlog.
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

  test("supersedes pull-request runs by pull-request number", () => {
    expect(group).toContain(
      "github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number)",
    );
  });

  test("supersedes merge-group runs by their stable candidate ref", () => {
    expect(group).not.toContain("github.event_name == 'merge_group'");
    expect(group).toContain("|| github.ref || github.run_id");
  });

  test("lets one develop push finish while retaining only the newest pending tip", () => {
    expect(group).toContain(
      "github.event_name == 'push' && format('terminal-v2-{0}', github.ref)",
    );
    expect(group).not.toContain("format('terminal-v2-{0}', github.run_id)");
    expect(group).not.toContain("format('terminal-v2-{0}', github.sha)");
    expect(concurrency?.queue).toBeUndefined();
  });

  test("cancels only stale pull-request and merge-group work", () => {
    expect(concurrency?.["cancel-in-progress"]).toBe(
      `\${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}`,
    );
  });
});
