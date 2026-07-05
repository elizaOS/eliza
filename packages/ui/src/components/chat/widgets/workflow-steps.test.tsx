// @vitest-environment jsdom
//
// WorkflowSteps: renders step k/N progress, per-step status data attributes,
// and a spinning icon only for the running step. jsdom render, no backend.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowSpec } from "../message-workflow-parser";
import { WorkflowSteps } from "./workflow-steps";

const spec: WorkflowSpec = {
  id: "w1",
  title: "Deploy",
  steps: [
    { label: "build", status: "done" },
    { label: "push", status: "running" },
    { label: "verify", status: "pending" },
  ],
};

describe("WorkflowSteps", () => {
  afterEach(cleanup);

  it("renders each step with its status and a done/total count", () => {
    render(<WorkflowSteps workflow={spec} />);
    const root = screen.getByTestId("workflow-steps");
    expect(root.getAttribute("data-workflow-id")).toBe("w1");
    expect(root.textContent).toContain("Deploy");
    expect(root.textContent).toContain("1/3");
    const items = root.querySelectorAll("li");
    expect(items).toHaveLength(3);
    expect(items[0].getAttribute("data-status")).toBe("done");
    expect(items[1].getAttribute("data-status")).toBe("running");
  });

  it("spins only the running step", () => {
    render(<WorkflowSteps workflow={spec} />);
    const spinners = screen
      .getByTestId("workflow-steps")
      .querySelectorAll(".animate-spin");
    expect(spinners).toHaveLength(1);
  });
});
