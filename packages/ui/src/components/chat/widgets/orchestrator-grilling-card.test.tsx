// @vitest-environment jsdom
//
// OrchestratorGrillingCard: renders the goal, verdict, and one row per criterion,
// stamps each criterion's state (for icon selection), shows a note only when
// present, and shows the reviewing verdict for the pending status. Pure jsdom
// render over fixture props — presentational component, no backend.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GrillingCriterion,
  OrchestratorGrillingCard,
} from "./orchestrator-grilling-card";

afterEach(cleanup);

const criteria: GrillingCriterion[] = [
  { id: "a", label: "Has a test", state: "met", note: "6 of 6 covered" },
  { id: "b", label: "Renders cleanly", state: "failed" },
  { id: "c", label: "Exports types", state: "pending" },
];

describe("OrchestratorGrillingCard", () => {
  it("renders the goal, verdict, and one row per criterion", () => {
    render(
      <OrchestratorGrillingCard
        status="criteria-met"
        goal="Ship the widget"
        criteria={criteria}
      />,
    );
    const card = screen.getByTestId("orchestrator-grilling");
    expect(card.getAttribute("data-grilling-status")).toBe("criteria-met");
    expect(card.textContent).toContain("Ship the widget");
    expect(
      screen.getByTestId("orchestrator-grilling-status").textContent,
    ).toContain("Criteria met");
    expect(screen.getByTestId("grilling-criterion-a")).toBeTruthy();
    expect(screen.getByTestId("grilling-criterion-b")).toBeTruthy();
    expect(screen.getByTestId("grilling-criterion-c")).toBeTruthy();
  });

  it("stamps each criterion's state for visual/icon selection", () => {
    render(
      <OrchestratorGrillingCard
        status="criteria-failed"
        goal="g"
        criteria={criteria}
      />,
    );
    expect(
      screen
        .getByTestId("grilling-criterion-a")
        .getAttribute("data-criterion-state"),
    ).toBe("met");
    expect(
      screen
        .getByTestId("grilling-criterion-b")
        .getAttribute("data-criterion-state"),
    ).toBe("failed");
    expect(
      screen
        .getByTestId("grilling-criterion-c")
        .getAttribute("data-criterion-state"),
    ).toBe("pending");
  });

  it("renders a criterion note only when present", () => {
    render(
      <OrchestratorGrillingCard
        status="evidence-pending"
        goal="g"
        criteria={criteria}
      />,
    );
    expect(screen.getByTestId("grilling-criterion-a").textContent).toContain(
      "6 of 6 covered",
    );
    // Criterion b has no note — its row text is just the label + state label.
    expect(screen.getByTestId("grilling-criterion-b").textContent).toContain(
      "Renders cleanly",
    );
  });

  it("shows the reviewing verdict for the pending status", () => {
    render(
      <OrchestratorGrillingCard
        status="evidence-pending"
        goal="g"
        criteria={[]}
      />,
    );
    expect(
      screen.getByTestId("orchestrator-grilling-status").textContent,
    ).toContain("Reviewing evidence");
  });
});
