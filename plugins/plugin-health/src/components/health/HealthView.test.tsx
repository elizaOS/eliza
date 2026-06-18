// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LifeOpsPersonalBaselineResponse,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
} from "../../contracts/health.js";

// `@elizaos/ui` is the giant renderer barrel; the component only touches
// `client.getBaseUrl()` on its default fetcher seam, which every test
// overrides. `@elizaos/ui/agent-surface` is mocked to an inert hook so the
// agent-instrumented controls render outside a provider.
vi.mock("@elizaos/ui", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

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

    expect(screen.getByTestId("health-loading")).toBeTruthy();
    expect(screen.getByText(/Loading sleep data/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Refresh sleep data" }),
    ).toBeTruthy();
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

    const error = await screen.findByTestId("health-error");
    expect(within(error).getByText("network down")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    expect(await screen.findByTestId("health-empty")).toBeTruthy();
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("renders the empty (connect-a-source) state when no episodes exist", async () => {
    render(<HealthView fetchers={makeFetchers(emptyHistory())} />);

    const empty = await screen.findByTestId("health-empty");
    expect(within(empty).getByText(/No sleep data yet/i)).toBeTruthy();
    expect(
      within(empty).getByText(/Connect a\s+health source \(Apple Health/i),
    ).toBeTruthy();
    expect(
      within(empty).getByText(/connect a health source.*get started/i),
    ).toBeTruthy();
  });

  it("renders the populated state with latest night, regularity, and baseline", async () => {
    render(<HealthView fetchers={makeFetchers(populatedHistory())} />);

    const populated = await screen.findByTestId("health-populated");

    // Latest-night summary: duration, bedtime, wake, type, source, confidence.
    const latest = within(populated).getByTestId("health-latest-night");
    expect(within(latest).getByText("7h 45m")).toBeTruthy();
    expect(within(latest).getByText("overnight")).toBeTruthy();
    expect(within(latest).getByText("health")).toBeTruthy();
    expect(within(latest).getByText("92%")).toBeTruthy();

    // Regularity score.
    const regularity = within(populated).getByTestId("health-regularity");
    expect(within(regularity).getByText("Regular")).toBeTruthy();
    expect(within(regularity).getByText("78")).toBeTruthy();

    // Personal baseline.
    const baseline = within(populated).getByTestId("health-baseline");
    expect(within(baseline).getByText("23:30")).toBeTruthy();
    expect(within(baseline).getByText("07:15")).toBeTruthy();

    // Window summary derived from the history summary DTO (averageDurationMin
    // 452 → "7h 32m" is unique to this card).
    const summary = within(populated).getByTestId("health-window-summary");
    expect(within(summary).getByText("7h 32m")).toBeTruthy();
    expect(within(summary).getByText("Nights recorded")).toBeTruthy();
  });

  it("refetches all three endpoints when the window-range control changes", async () => {
    const fetchers = makeFetchers(populatedHistory());
    render(<HealthView fetchers={fetchers} initialWindowDays={14} />);

    await screen.findByTestId("health-populated");
    expect(fetchers.fetchHistory).toHaveBeenCalledTimes(1);
    expect(fetchers.fetchHistory).toHaveBeenLastCalledWith(14);

    fireEvent.click(screen.getByRole("button", { name: "Show last 30 days" }));

    await waitFor(() => expect(fetchers.fetchHistory).toHaveBeenCalledTimes(2));
    expect(fetchers.fetchHistory).toHaveBeenLastCalledWith(30);
    expect(fetchers.fetchRegularity).toHaveBeenLastCalledWith(30);
    expect(fetchers.fetchBaseline).toHaveBeenLastCalledWith(30);
  });

  it("refetches when the header Refresh control is clicked", async () => {
    const fetchers = makeFetchers(populatedHistory());
    render(<HealthView fetchers={fetchers} />);

    await screen.findByTestId("health-populated");
    expect(fetchers.fetchHistory).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh sleep data" }));
    await waitFor(() => expect(fetchers.fetchHistory).toHaveBeenCalledTimes(2));
  });

  it("interpolates the supplied ownerName into the subtitle", async () => {
    render(
      <HealthView ownerName="Dana" fetchers={makeFetchers(emptyHistory())} />,
    );

    await screen.findByTestId("health-empty");
    expect(
      screen.getByText(
        "Sleep, circadian rhythm, and the rolling baseline for Dana.",
      ),
    ).toBeTruthy();
  });
});
