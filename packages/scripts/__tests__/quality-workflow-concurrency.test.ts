/**
 * Pins the quality.yml concurrency contract: push runs on develop/main must
 * never cancel in progress. Rapid merge waves previously canceled every
 * quality run mid-flight, so lint/format reds on develop landed invisibly
 * until a release pin surfaced them (#18326, #18338, #18360). The shared
 * ref group bounds the queue at one running plus one pending run (#14069),
 * so completion cannot starve the runner fleet. Deterministic, reads the
 * real workflow file.
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

  test("shares one concurrency group per ref so pushes supersede, not queue", () => {
    const group = workflow.concurrency?.group;
    expect(group).toStartWith("quality-");
    expect(group).toContain("github.event.pull_request.number || github.ref");
    // An unconditional run_id fallback would give every push a unique group
    // and re-open the unbounded queue from #14069. run_id may appear only
    // behind an explicit workflow_dispatch guard, so a manual health read is
    // not parked behind — and then superseded by — the develop push queue.
    const dispatchGuard =
      "github.event_name == 'workflow_dispatch' && format('dispatch-{0}', github.run_id)";
    const withoutDispatchGuard = String(group).replace(dispatchGuard, "");
    expect(withoutDispatchGuard).not.toContain("run_id");
  });

  test("cancels in progress only for pull_request events, never push", () => {
    const cancel = String(workflow.concurrency?.["cancel-in-progress"]);
    expect(cancel).toContain("github.event_name == 'pull_request'");
    expect(cancel).not.toContain("push");
  });
});
