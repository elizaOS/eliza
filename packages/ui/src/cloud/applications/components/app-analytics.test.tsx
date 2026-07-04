// @vitest-environment jsdom

/**
 * `AppAnalytics` sessions tab (#11349): it loads and renders the session
 * summary, funnel, and recent-sessions list straight from the analytics DTO.
 * The api-client, `sonner`, and `recharts` are doubled; the component renders
 * for real against the mocked DTO.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api-client")>(
    "../../lib/api-client",
  );
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PieChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Line: () => null,
  Bar: () => null,
  Pie: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
}));

import { AppAnalytics } from "./app-analytics";

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  toastErrorMock.mockReset();
});

function mockAnalyticsResponses() {
  apiMock.mockImplementation(async (url: string) => {
    if (url.includes("/analytics?")) {
      return {
        success: true,
        analytics: [],
        totalStats: {
          totalRequests: 0,
          totalUsers: 0,
          totalCreditsUsed: "0",
        },
      };
    }
    if (url.includes("view=stats")) {
      return {
        success: true,
        stats: {
          totalRequests: 5,
          uniqueIps: 2,
          uniqueUsers: 0,
          byType: { pageview: 5 },
          bySource: { hosted_frontend: 5 },
          byStatus: { success: 5 },
          totalCredits: "0",
          avgResponseTime: null,
        },
      };
    }
    if (url.includes("view=visitors")) {
      return { success: true, visitors: [] };
    }
    if (url.includes("view=sessions")) {
      return {
        success: true,
        sessions: {
          summary: {
            totalSessions: 2,
            uniqueVisitors: 2,
            totalPageViews: 5,
            avgPagesPerSession: 2.5,
            avgSessionDurationMs: 120000,
            bounceRatePercent: 0,
          },
          sessions: [
            {
              sessionId: "session-a",
              visitorId: "visitor-a",
              startedAt: "2026-07-02T12:00:00.000Z",
              endedAt: "2026-07-02T12:04:00.000Z",
              durationMs: 240000,
              pageViews: 3,
              entryPath: "/",
              exitPath: "/checkout",
            },
          ],
          funnel: {
            totalEntrants: 2,
            steps: [
              {
                path: "/",
                label: "Home",
                sessions: 2,
                visitors: 2,
                conversionFromStartPercent: 100,
                conversionFromPreviousPercent: 100,
              },
              {
                path: "/checkout",
                label: "Checkout",
                sessions: 1,
                visitors: 1,
                conversionFromStartPercent: 50,
                conversionFromPreviousPercent: 50,
              },
            ],
          },
        },
      };
    }
    return { success: true };
  });
}

describe("AppAnalytics sessions tab (#11349)", () => {
  it("loads and renders session summary, funnel, and recent sessions from the DTO", async () => {
    mockAnalyticsResponses();
    const user = userEvent.setup({ delay: null });
    render(<AppAnalytics appId="app_1" />);

    await screen.findByText("Requests Over Time");
    await user.click(screen.getByRole("button", { name: /Sessions/i }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/v1/apps/app_1/analytics/requests?view=sessions&limit=20",
      ),
    );
    expect(await screen.findByText("Funnel")).toBeTruthy();
    expect(screen.getByText("2.5")).toBeTruthy();
    expect(screen.getByText("Checkout")).toBeTruthy();
    expect(screen.getAllByText("/checkout").length).toBeGreaterThan(0);
    expect(screen.getByText("3")).toBeTruthy();
  });
});
