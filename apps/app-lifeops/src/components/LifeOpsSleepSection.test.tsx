// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getLifeOpsOverview: vi.fn(),
    getLifeOpsPersonalBaseline: vi.fn(),
    getLifeOpsSleepHistory: vi.fn(),
    getLifeOpsSleepRegularity: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core", () => ({
  client: clientMock,
}));

import { LifeOpsSleepSection } from "./LifeOpsSleepSection.js";

beforeEach(() => {
  clientMock.getLifeOpsOverview.mockResolvedValue({
    schedule: {
      lastSleepDurationMinutes: 480,
      relativeTime: {
        bedtimeTargetAt: "2026-04-25T06:00:00.000Z",
        wakeAnchorAt: "2026-04-25T14:00:00.000Z",
      },
      sleepStatus: "slept",
      wakeAt: "2026-04-25T14:00:00.000Z",
    },
  });
  clientMock.getLifeOpsSleepHistory.mockResolvedValue({
    episodes: [
      {
        confidence: 0.9,
        cycleType: "overnight",
        durationMin: 480,
        endedAt: "2026-04-25T14:00:00.000Z",
        id: "sleep-1",
        source: "health",
        startedAt: "2026-04-25T06:00:00.000Z",
      },
    ],
    includeNaps: false,
    windowDays: 365,
  });
  clientMock.getLifeOpsSleepRegularity.mockResolvedValue({
    bedtimeStddevMin: 22,
    classification: "regular",
    midSleepStddevMin: 18,
    sampleSize: 12,
    sri: 84,
    wakeStddevMin: 25,
    windowDays: 365,
  });
  clientMock.getLifeOpsPersonalBaseline.mockResolvedValue({
    bedtimeStddevMin: 22,
    medianBedtimeLocalHour: 23,
    medianSleepDurationMin: 480,
    medianWakeLocalHour: 7,
    sampleSize: 12,
    wakeStddevMin: 25,
    windowDays: 365,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsSleepSection", () => {
  it("loads tonight and requests full-year history from the history tab", async () => {
    render(<LifeOpsSleepSection />);

    expect(screen.getByTestId("lifeops-sleep-section")).toBeTruthy();
    await waitFor(() => expect(clientMock.getLifeOpsOverview).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("tab", { name: "History" }));

    await waitFor(() =>
      expect(clientMock.getLifeOpsSleepHistory).toHaveBeenCalledWith({
        includeNaps: false,
        windowDays: 365,
      }),
    );
    expect(await screen.findByTestId("sleep-history-list")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "All year" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("loads regularity and baseline data from the pattern tab", async () => {
    render(<LifeOpsSleepSection />);

    fireEvent.click(screen.getByRole("tab", { name: "Pattern" }));

    await waitFor(() =>
      expect(clientMock.getLifeOpsSleepRegularity).toHaveBeenCalledWith({
        includeNaps: false,
      }),
    );
    expect(clientMock.getLifeOpsPersonalBaseline).toHaveBeenCalled();
    expect(await screen.findByText("Regular")).toBeTruthy();
  });
});
