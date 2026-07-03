import { describe, expect, it } from "vitest";
import { classifyRuntimeActionNode } from "./automation-action-classifier.ts";

describe("classifyRuntimeActionNode", () => {
  it("classifies the orchestrator TASKS action from declared tags", () => {
    expect(
      classifyRuntimeActionNode({
        tags: [
          "domain:coding",
          "domain:agent-orchestration",
          "resource:agent-task",
          "capability:delegate",
        ],
      }),
    ).toBe("agent");
  });

  it("keeps ordinary runtime actions in the action class", () => {
    expect(classifyRuntimeActionNode({ tags: ["domain:settings"] })).toBe(
      "action",
    );
  });
});
