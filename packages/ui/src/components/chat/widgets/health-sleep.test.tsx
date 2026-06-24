// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBaseUrlMock, publishHomeAttentionSpy } = vi.hoisted(() => ({
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  publishHomeAttentionSpy: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: { getBaseUrl: getBaseUrlMock },
}));

vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: publishHomeAttentionSpy,
}));

import { HealthSleepWidget } from "./health-sleep";

// Wire shapes mirror HealthView's parse (plugins/plugin-health/src/components/
// health/HealthView.tsx): the history endpoint returns `{ episodes: [...] }`
// (LifeOpsSleepHistoryEpisode) and the regularity endpoint returns
// `{ classification }` (LifeOpsRegularityClass).
function episode(
  overrides: {
    startedAt?: string;
    endedAt?: string | null;
    durationMin?: number | null;
  } = {},
) {
  return {
    id: "ep1",
    startedAt: overrides.startedAt ?? "2026-06-23T23:30:00.000Z",
    endedAt: overrides.endedAt ?? "2026-06-24T07:15:00.000Z",
    durationMin: overrides.durationMin ?? 465,
    cycleType: "overnight",
    source: "manual",
    confidence: 0.9,
  };
}

/**
 * Dispatch the two `/api/lifeops/sleep/*` GETs the widget makes to the seeded
 * history + regularity payloads. `regularity: null` means "no classification".
 */
function mockSleep(opts: {
  episodes: ReturnType<typeof episode>[];
  classification?: string | null;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/lifeops/sleep/history")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ episodes: opts.episodes }),
        };
      }
      if (url.includes("/api/lifeops/sleep/regularity")) {
        return {
          ok: true,
          status: 200,
          json: async () =>
            opts.classification == null
              ? {}
              : { classification: opts.classification },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  publishHomeAttentionSpy.mockClear();
});

describe("HealthSleepWidget (#9143)", () => {
  it("renders the latest sleep episode and regularity classification", async () => {
    mockSleep({
      episodes: [episode({ durationMin: 465 })],
      classification: "regular",
    });

    render(<HealthSleepWidget pluginId="health" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-health-sleep")).toBeTruthy();
    });
    // 465 min -> "7h 45m" (formatDuration) + the regularity badge label.
    expect(screen.getByText("7h 45m")).toBeTruthy();
    expect(screen.getByText("Regular")).toBeTruthy();
  });

  it("renders nothing when there are no sleep episodes in the window", async () => {
    mockSleep({ episodes: [], classification: "regular" });

    const { container } = render(<HealthSleepWidget pluginId="health" />);

    await waitFor(() => {
      expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("widget-health-sleep")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("publishes the check-in weight when sleep is irregular", async () => {
    mockSleep({
      episodes: [episode()],
      classification: "very_irregular",
    });

    render(<HealthSleepWidget pluginId="health" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-health-sleep")).toBeTruthy();
    });
    // HOME_SIGNAL_WEIGHTS["check-in"] === 4 (packages/ui/src/widgets/home-priority.ts).
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "health/health.sleep",
      4,
    );
  });

  it("publishes null (no boost) when sleep regularity is fine", async () => {
    mockSleep({ episodes: [episode()], classification: "regular" });

    render(<HealthSleepWidget pluginId="health" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-health-sleep")).toBeTruthy();
    });
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "health/health.sleep",
      null,
    );
  });
});
