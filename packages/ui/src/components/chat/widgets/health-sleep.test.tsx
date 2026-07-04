// @vitest-environment jsdom
//
// HealthSleepWidget: one high-priority datum (latest sleep duration) on a
// clickable card, an off-rhythm badge and published check-in weight when sleep is
// irregular, navigation to the Health view on tap, and self-hide when no sleep
// episodes fall in the window. jsdom render with the API client mocked.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth gate (#11084) — mutable so tests can flip the session state. Default
// authenticated so the pre-gate behavior tests exercise the live poll path.
const { authMock } = vi.hoisted(() => ({
  authMock: { authenticated: true },
}));
vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

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

// useWidgetNavigation → reportUserViewSwitch (from the slash-command controller);
// stub it so the click test isolates the navigation rail (the CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
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
  authMock.authenticated = true;
  publishHomeAttentionSpy.mockClear();
});

describe("HealthSleepWidget (#9143)", () => {
  it("shows ONE high-priority datum — the latest sleep duration — on a clickable card (minimal, icon-first)", async () => {
    mockSleep({
      episodes: [episode({ durationMin: 465 })],
      classification: "regular",
    });

    render(<HealthSleepWidget slot="home" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-health-sleep")).toBeTruthy();
    });

    const widget = screen.getByTestId("widget-health-sleep");
    // The card is a button (whole-card clickable) and minimal: the single datum
    // is the formatted duration (465 min -> "7h 45m"). A "regular" night is NOT
    // off-rhythm, so no badge is shown.
    expect(widget.tagName).toBe("BUTTON");
    expect(widget.textContent).toContain("7h 45m");
    expect(widget.textContent).not.toContain("Regular");
    // The full meaning lives in the aria-label since visible text is minimal.
    expect(widget.getAttribute("aria-label")).toMatch(/sleep/i);
    expect(widget.getAttribute("aria-label")).toMatch(/7h 45m/);
  });

  it("shows the off-rhythm regularity as a badge when sleep is irregular", async () => {
    mockSleep({
      episodes: [episode({ durationMin: 345 })],
      classification: "irregular",
    });

    render(<HealthSleepWidget slot="home" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-health-sleep")).toBeTruthy();
    });

    const widget = screen.getByTestId("widget-health-sleep");
    // 345 min -> "5h 45m"; off-rhythm -> "Irregular" badge.
    expect(widget.textContent).toContain("5h 45m");
    expect(widget.textContent).toContain("Irregular");
  });

  it("navigates to the Health view when the card is clicked", async () => {
    mockSleep({ episodes: [episode()], classification: "regular" });

    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<HealthSleepWidget slot="home" />);
    await waitFor(() => {
      expect(screen.getByTestId("widget-health-sleep")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("widget-health-sleep"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/health");
  });

  it("renders nothing when there are no sleep episodes in the window", async () => {
    mockSleep({ episodes: [], classification: "regular" });

    const { container } = render(<HealthSleepWidget slot="home" />);

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

    render(<HealthSleepWidget slot="home" />);

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

    render(<HealthSleepWidget slot="home" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-health-sleep")).toBeTruthy();
    });
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "health/health.sleep",
      null,
    );
  });

  it("applies the host-supplied spanClassName to its single root grid-item element (#11752)", async () => {
    mockSleep({ episodes: [episode()], classification: "irregular" });

    const { container } = render(
      <HealthSleepWidget slot="home" spanClassName="col-span-2 row-span-1" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("widget-health-sleep")).toBeTruthy();
    });
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    expect(
      root?.querySelector('[data-testid="widget-health-sleep"]'),
    ).not.toBeNull();
  });

  it("falls back to the default 2x1 span when no spanClassName is supplied (#11752)", async () => {
    mockSleep({ episodes: [episode()], classification: "regular" });

    const { container } = render(<HealthSleepWidget slot="home" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-health-sleep")).toBeTruthy();
    });
    expect(container.firstElementChild?.className).toContain("col-span-2");
  });
});
