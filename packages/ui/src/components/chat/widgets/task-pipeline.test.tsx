// @vitest-environment jsdom
//
// Pipeline presentational pieces: the live PlanChecklist (three distinguishable
// item states + done/total), the SubagentBlock (status, current line, nested
// indent, tool steps reusing ToolCallEventLog), and the tool-event mapping.
// jsdom render, no backend.

import type { SwarmActivityPlanEntry } from "@elizaos/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentActivity } from "../../../state/task-activity-store";
import {
  PlanChecklist,
  SubagentBlock,
  toNativeToolEvent,
} from "./task-pipeline";

const plan: SwarmActivityPlanEntry[] = [
  { content: "read the file", status: "completed" },
  { content: "apply edit", status: "in_progress" },
  { content: "run tests", status: "pending" },
];

describe("PlanChecklist", () => {
  afterEach(cleanup);

  it("renders three distinguishable item states and a done/total count", () => {
    render(<PlanChecklist entries={plan} title="Plan" />);
    const root = screen.getByTestId("plan-checklist");
    expect(root.textContent).toContain("1/3");
    const items = root.querySelectorAll("li");
    expect(items[0].getAttribute("data-status")).toBe("completed");
    expect(items[0].className).toContain("line-through");
    expect(items[1].getAttribute("data-status")).toBe("in_progress");
    expect(items[2].getAttribute("data-status")).toBe("pending");
  });

  it("renders nothing for an empty plan", () => {
    const { container } = render(<PlanChecklist entries={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("SubagentBlock", () => {
  afterEach(cleanup);

  const agent: SubagentActivity = {
    sessionId: "sess-abcdef12",
    status: "running",
    label: "backend agent",
    currentText: "editing swarm-coordinator.ts",
    steps: [
      {
        id: "t1",
        seq: 1,
        timestamp: 1,
        tool: {
          id: "t1",
          title: "Bash",
          kind: "execute",
          status: "success",
          rawInput: { command: "git status" },
          output: "clean",
        },
      },
    ],
    plan,
    updatedAt: 1,
    firstSeq: 1,
  };

  it("renders status, current line, plan, and a reused tool-call row", () => {
    render(<SubagentBlock agent={agent} />);
    const block = screen.getByTestId("subagent-block");
    expect(block.getAttribute("data-status")).toBe("running");
    expect(block.textContent).toContain("backend agent");
    expect(block.textContent).toContain("editing swarm-coordinator.ts");
    expect(screen.getByTestId("plan-checklist")).toBeTruthy();
    expect(screen.getByTestId("tool-call-event-log")).toBeTruthy();
  });

  it("indents a nested child session", () => {
    render(
      <SubagentBlock
        agent={{
          ...agent,
          parentSessionId: "parent",
          steps: [],
          plan: undefined,
        }}
      />,
    );
    expect(screen.getByTestId("subagent-block").className).toContain(
      "border-l",
    );
  });
});

describe("toNativeToolEvent", () => {
  it("maps a failed tool to a tool_error with the error field set", () => {
    const ev = toNativeToolEvent({
      id: "x",
      seq: 2,
      timestamp: 2,
      tool: { id: "x", title: "Read", status: "failure", output: "ENOENT" },
    });
    expect(ev.type).toBe("tool_error");
    expect(ev.status).toBe("failed");
    expect(ev.error).toBe("ENOENT");
  });

  it("maps a running tool to a tool_call", () => {
    const ev = toNativeToolEvent({
      id: "y",
      seq: 3,
      timestamp: 3,
      tool: { status: "running", title: "Grep" },
    });
    expect(ev.type).toBe("tool_call");
    expect(ev.status).toBe("running");
    expect(ev.toolName).toBe("Grep");
  });
});
