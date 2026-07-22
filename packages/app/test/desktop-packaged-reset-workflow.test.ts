/**
 * Guards the supported-platform packaged reset lane without replacing its real
 * macOS launcher proof with a renderer fixture or static application-menu mock.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  name?: string;
  "runs-on"?: string;
  steps?: WorkflowStep[];
}

const workflowPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.github/workflows/desktop-packaged-reset.yml",
);

describe("desktop packaged reset workflow", () => {
  it("runs the real application-menu reset on a supported macOS launcher", () => {
    const workflow = parse(readFileSync(workflowPath, "utf8")) as {
      jobs?: Record<string, WorkflowJob>;
    };
    const job = workflow.jobs?.["reset-macos"];
    expect(job?.["runs-on"]).toBe("macos-15");

    const resetStep = job?.steps?.find(
      (step) =>
        step.name === "Drive reset through the real packaged application menu",
    );
    expect(resetStep?.run).toContain("test:desktop:packaged");
    expect(resetStep?.run).toContain(
      "packaged desktop reset from the application menu",
    );
  });

  it("runs on relevant pull requests and develop pushes", () => {
    const source = readFileSync(workflowPath, "utf8");
    expect(source).toContain("pull_request:");
    expect(source).toContain("push:");
    expect(source.match(/branches: \[develop\]/g)).toHaveLength(2);
    expect(source).toContain('      - "packages/app/**"');
    expect(source).toContain('      - "packages/app-core/**"');
    expect(source).toContain('      - "packages/ui/src/state/**"');
    expect(source).toContain('      - "packages/agent/src/api/**"');
  });
});
