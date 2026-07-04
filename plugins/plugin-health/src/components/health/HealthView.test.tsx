/**
 * @vitest-environment jsdom
 *
 * Drives the unified HealthView (the single GUI/XR data wrapper) through the
 * rendered spatial DOM: the same component the bundle exports for both the
 * "gui" and "xr" modalities. It is a read-only sleep summary over the three
 * endpoints the host serves:
 *   GET {base}/api/lifeops/sleep/{history,regularity,baseline}
 *
 * The default fetchers hit those URLs via `client.getBaseUrl()`; every test
 * here injects the `fetchers` seam so the suite stays offline. We assert the
 * rendered spatial DOM across the four states (loading / error / empty /
 * populated), the window-range control, and the quiet 20s background poll.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// HealthView only touches client.getBaseUrl; spatial primitives stay unmocked.
vi.mock("@elizaos/ui", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));

import type {
  LifeOpsPersonalBaselineResponse,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
} from "../../contracts/health.js";
import { HealthView, type SleepFetchers } from "./HealthView.js";

// ---------------------------------------------------------------------------
// DTO fixtures — exact wire shapes from src/routes/sleep.ts service methods.
// ---------------------------------------------------------------------------

function populatedHistory(
  overrides: Partial<LifeOpsSleepHistoryResponse> = {},
): LifeOpsSleepHistoryResponse {
  return {
    episodes: [
      {
        id: "ep-1",
        startedAt: "2026-06-16T23:30:00.000Z",
        endedAt: "2026-06-17T07:15:00.000Z",
        durationMin: 465,
        cycleType: "overnight",
        source: "health",
        confidence: 0.92,
      },
    ],
    summary: {
      cycleCount: 6,
      averageDurationMin: 452,
      overnightCount: 6,
      napCount: 0,
      openCount: 0,
    },
    windowDays: 14,
    includeNaps: true,
    ...overrides,
  };
}

function emptyHistory(
  overrides: Partial<LifeOpsSleepHistoryResponse> = {},
): LifeOpsSleepHistoryResponse {
  return {
    episodes: [],
    summary: {
      cycleCount: 0,
      averageDurationMin: null,
      overnightCount: 0,
      napCount: 0,
      openCount: 0,
    },
    windowDays: 14,
    includeNaps: true,
    ...overrides,
  };
}

const REGULARITY: LifeOpsSleepRegularityResponse = {
  sri: 78.4,
  classification: "regular",
  bedtimeStddevMin: 42,
  wakeStddevMin: 31,
  midSleepStddevMin: 36,
  sampleSize: 6,
  windowDays: 14,
};

const BASELINE: LifeOpsPersonalBaselineResponse = {
  medianBedtimeLocalHour: 23.5,
  medianWakeLocalHour: 7.25,
  medianSleepDurationMin: 452,
  bedtimeStddevMin: 42,
  wakeStddevMin: 31,
  sampleSize: 6,
  windowDays: 14,
};

function makeFetchers(history: LifeOpsSleepHistoryResponse): SleepFetchers {
  return {
    fetchHistory: vi.fn(async () => history),
    fetchRegularity: vi.fn(async () => REGULARITY),
    fetchBaseline: vi.fn(async () => BASELINE),
  };
}

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

describe("HealthView (fetch-driven)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the loading state while the initial fetch is in flight", () => {
    const fetchers: SleepFetchers = {
      fetchHistory: () => new Promise(() => {}),
      fetchRegularity: () => new Promise(() => {}),
      fetchBaseline: () => new Promise(() => {}),
    };
    render(<HealthView fetchers={fetchers} />);
    expect(screen.getByText("Loading")).toBeTruthy();
  });

  it("renders the error state and refetches when Retry is clicked", async () => {
    let attempt = 0;
    const fetchHistory = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return emptyHistory();
    });
    const fetchers: SleepFetchers = {
      fetchHistory,
      fetchRegularity: vi.fn(async () => REGULARITY),
      fetchBaseline: vi.fn(async () => BASELINE),
    };

    render(<HealthView fetchers={fetchers} />);

    await screen.findByText("network down");
    fireEvent.click(agent("retry"));

    await screen.findByText("None");
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("renders the empty (connect-a-source) state when no episodes exist", async () => {
    render(<HealthView fetchers={makeFetchers(emptyHistory())} />);

    await screen.findByText("None");
    expect(screen.queryByText("14d empty")).toBeNull();
  });

  it("renders the populated state with last sleep, regularity, baseline, and window summary", async () => {
    render(<HealthView fetchers={makeFetchers(populatedHistory())} />);

    // Last-sleep summary: duration, type, source, confidence.
    await screen.findByText("7h 45m");
    expect(screen.getByText("overnight")).toBeTruthy();
    expect(screen.getByText("health")).toBeTruthy();
    expect(screen.getByText("92%")).toBeTruthy();

    // Regularity.
    expect(screen.getByText("Regular")).toBeTruthy();
    expect(screen.getByText("78")).toBeTruthy();

    // Baseline.
    expect(screen.getByText("23:30")).toBeTruthy();
    expect(screen.getByText("07:15")).toBeTruthy();

    // Window summary: "Nights recorded" + cycleCount 6 (averageDurationMin 452
    // also formats "7h 32m" but so does the baseline typical-duration row, so
    // assert the labels unique to this section instead).
    expect(screen.getByText("Nights recorded")).toBeTruthy();
    expect(screen.getByText("Average duration")).toBeTruthy();

    // Section dividers are present.
    expect(screen.getByText("Last sleep")).toBeTruthy();
    expect(screen.getByText("Window summary")).toBeTruthy();
  });

  it("shows a quiet proactive line only when regularity reads as off-rhythm", async () => {
    const irregular: LifeOpsSleepRegularityResponse = {
      ...REGULARITY,
      classification: "very_irregular",
    };
    const fetchers: SleepFetchers = {
      fetchHistory: vi.fn(async () => populatedHistory()),
      fetchRegularity: vi.fn(async () => irregular),
      fetchBaseline: vi.fn(async () => BASELINE),
    };
    render(<HealthView fetchers={fetchers} />);

    // "Very irregular" appears both as the classification value and inside the
    // proactive sentence; assert the full proactive line, which is unique.
    expect(
      await screen.findByText(/Sleep was very irregular this window/i),
    ).toBeTruthy();
  });

  it("renders no proactive line when regularity is regular", async () => {
    render(<HealthView fetchers={makeFetchers(populatedHistory())} />);

    await screen.findByText("7h 45m");
    expect(screen.queryByText(/irregular/i)).toBeNull();
  });

  it("refetches all three endpoints when the window-range control changes", async () => {
    const fetchers = makeFetchers(populatedHistory());
    render(<HealthView fetchers={fetchers} initialWindowDays={14} />);

    await screen.findByText("7h 45m");
    expect(fetchers.fetchHistory).toHaveBeenCalledTimes(1);
    expect(fetchers.fetchHistory).toHaveBeenLastCalledWith(14);

    fireEvent.click(agent("window-30"));

    await waitFor(() => expect(fetchers.fetchHistory).toHaveBeenCalledTimes(2));
    expect(fetchers.fetchHistory).toHaveBeenLastCalledWith(30);
    expect(fetchers.fetchRegularity).toHaveBeenLastCalledWith(30);
    expect(fetchers.fetchBaseline).toHaveBeenLastCalledWith(30);
  });

  it("refetches in the background on the quiet poll interval", async () => {
    vi.useFakeTimers();
    try {
      const fetchers = makeFetchers(populatedHistory());
      render(<HealthView fetchers={fetchers} />);

      // Flush the initial mount load's microtasks WITHOUT advancing to the
      // poll boundary (advanceTimersByTimeAsync(0) drains microtasks only).
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchers.fetchHistory).toHaveBeenCalledTimes(1);
      expect(fetchers.fetchHistory).toHaveBeenLastCalledWith(14);

      // Advancing exactly one interval triggers the quiet background poll —
      // there is no manual refresh control.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetchers.fetchHistory).toHaveBeenCalledTimes(2);
      expect(fetchers.fetchHistory).toHaveBeenLastCalledWith(14);
    } finally {
      vi.useRealTimers();
    }
  });
});
