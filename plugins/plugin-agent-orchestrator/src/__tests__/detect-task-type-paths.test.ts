import { describe, expect, it } from "vitest";
import { collapsePlannerLanes } from "../actions/tasks.js";
import { detectTaskType } from "../services/acceptance-criteria.js";

describe("detectTaskType ignores file names and paths", () => {
  it("a script that reads a file named *deploy* is a script-run, not a deploy", () => {
    const ask =
      "write a python script that reads /etc/nubs-deploy-settings.yaml and prints the region field";
    expect(detectTaskType(ask)).toBe("script-run");
    expect(
      collapsePlannerLanes(
        ask,
        ["write the script", "run it and report"],
        undefined,
      ),
    ).toHaveLength(1);
  });

  it("still detects a real deploy ask", () => {
    expect(detectTaskType("deploy the blog app to production")).toBe("deploy");
  });

  it("a widget.js path does not make a coding ask a view-create", () => {
    expect(detectTaskType("fix the null check in src/widget.js")).toBe(
      "coding",
    );
  });
});
