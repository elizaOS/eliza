/** Verifies rendered totals for the detail endpoint's missing-rollup shape. */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrajectoryDetailView } from "./TrajectoryDetailView";

const api = vi.hoisted(() => ({ getTrajectoryDetail: vi.fn() }));
vi.mock("../../api/client", () => ({ client: api }));
vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      t: (key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? key,
      copyToClipboard: vi.fn(),
    }),
}));
vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

const recordedUsage = [
  [38396, 425],
  [6298, 58],
  [2502, 80],
  [29501, 71],
  [11489, 200],
  [13394, 114],
];

function detail(unknownUsage = false) {
  return {
    trajectory: {
      id: "recorded-correction",
      status: "completed",
      llmCallCount: 6,
      providerAccessCount: 61,
      durationMs: 7468,
      createdAt: "2026-09-08T23:47:08.696Z",
    },
    llmCalls: recordedUsage.map(([promptTokens, completionTokens], index) => ({
      id: `call-${index}`,
      model: "fixture-model",
      purpose: "external_llm",
      timestamp: 1788911221228 + index,
      latencyMs: 100,
      maxTokens: 0,
      temperature: 0,
      promptTokens,
      completionTokens:
        unknownUsage && index === 0 ? undefined : completionTokens,
      userPrompt: "Recorded fixture input",
      response: "Recorded fixture output",
    })),
    providerAccesses: [],
  };
}

describe("TrajectoryDetailView recorded usage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders 102.5k instead of zero when the detail response omits rollups", async () => {
    api.getTrajectoryDetail.mockResolvedValue(detail());
    render(<TrajectoryDetailView trajectoryId="recorded-correction" />);
    await waitFor(() => {
      expect(
        screen
          .getByText("Tokens", { selector: "dt" })
          .parentElement?.querySelector("dd")?.textContent,
      ).toBe("102.5k");
    });
    expect(
      screen
        .getByText("Model calls", { selector: "dt" })
        .parentElement?.querySelector("dd")?.textContent,
    ).toBe("6");
    expect(
      screen
        .getByText("Provider reads", { selector: "dt" })
        .parentElement?.querySelector("dd")?.textContent,
    ).toBe("61");
  });

  it("renders unknown total usage as a dash rather than a partial sum", async () => {
    api.getTrajectoryDetail.mockResolvedValue(detail(true));
    render(<TrajectoryDetailView trajectoryId="recorded-correction" />);
    await waitFor(() => {
      expect(
        screen
          .getByText("Tokens", { selector: "dt" })
          .parentElement?.querySelector("dd")?.textContent,
      ).toBe("—");
    });
  });
});
