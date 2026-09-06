/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { TrajectoryDetail } from "../api-client";
import { TrajectoryRecord } from "./TrajectoryRecord";

afterEach(cleanup);

const detail: TrajectoryDetail = {
  trajectory: {
    id: "record-1",
    status: "completed",
    llmCallCount: 0,
    startTime: 1000,
    durationMs: 400,
  },
  llmCalls: [],
  providerAccesses: [],
  semanticStages: [
    {
      stageId: "stage-1",
      kind: "tool",
      startedAt: 1100,
      endedAt: 1200,
      latencyMs: 100,
      payload: {
        tool: {
          name: "VIEWS",
          args: { action: "show", view: "chat" },
          untrusted: "<script>alert(1)</script>",
        },
      },
    },
  ],
};

it("shows recorded offsets without claiming response latency", () => {
  render(<TrajectoryRecord detail={detail} />);
  expect(screen.getByText("+100 ms")).toBeTruthy();
  expect(screen.getByText("+200 ms")).toBeTruthy();
  expect(screen.getByText(/not browser first-token/)).toBeTruthy();
});

it("mounts full data only on disclosure and renders tool content as text", () => {
  const { container } = render(<TrajectoryRecord detail={detail} />);
  expect(container.querySelector("pre")).toBeNull();
  const disclosure = screen
    .getByText("1. tool: recorded inputs and outputs")
    .closest("details");
  if (!disclosure) throw new Error("Missing recorded-data disclosure");
  disclosure.open = true;
  fireEvent(disclosure, new Event("toggle"));
  expect(container.querySelector("pre")?.textContent).toContain(
    "<script>alert(1)</script>",
  );
  expect(container.querySelector("script")).toBeNull();
  disclosure.open = false;
  fireEvent(disclosure, new Event("toggle"));
  expect(container.querySelector("pre")).toBeNull();
});

it("distinguishes missing timing from zero", () => {
  render(
    <TrajectoryRecord
      detail={{
        ...detail,
        trajectory: { id: "old", status: "completed", llmCallCount: 0 },
        semanticStages: [],
      }}
    />,
  );
  expect(screen.getByText(/Unknown ms total/)).toBeTruthy();
  expect(screen.getByText(/No semantic stage timings/)).toBeTruthy();
});
