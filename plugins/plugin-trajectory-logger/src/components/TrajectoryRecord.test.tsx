/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TrajectoryDetail } from "../api-client";
import { TrajectoryRecord } from "./TrajectoryRecord";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

it("loads optional timings only on request and keeps the trajectory on failure", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response("loopback only", { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<TrajectoryRecord detail={detail} />);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Load server timings" }));
  expect(
    await screen.findByText(/Server timings could not be loaded/),
  ).toBeTruthy();
  expect(screen.getByText("record-1")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Reload server timings" }),
  ).toBeTruthy();
});

it("distinguishes host delivery, internal tokens, missing marks and unattributed time", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          turns: [
            {
              turnId: "inference-1",
              timeToFirstVisibleMs: 3664,
              timeToReplyMs: 3665,
              timeToResponseFinalizedMs: null,
              totalMs: 3673,
              timeToFirstTokenMs: 1261,
              spans: [{ meta: { trajectoryId: "record-1" } }],
              anomalies: ["duplicate-first-token"],
            },
          ],
          flows: [
            {
              turnId: "inference-1",
              stages: [
                { stage: "unattributed", totalMs: 88, toFirstVisibleMs: 85 },
              ],
            },
          ],
        }),
      ),
    ),
  );
  render(<TrajectoryRecord detail={detail} />);
  fireEvent.click(screen.getByRole("button", { name: "Load server timings" }));
  expect(await screen.findByText("3664 ms")).toBeTruthy();
  expect(screen.getByText("Not recorded")).toBeTruthy();
  expect(screen.getByText(/Host delivery is not browser paint/)).toBeTruthy();
  expect(screen.getByText("unattributed")).toBeTruthy();
  expect(screen.getByText(/duplicate-first-token/)).toBeTruthy();
});
