// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth gate (#11084) — mutable so tests can flip the session state. Default
// authenticated so the pre-gate behavior tests exercise the live poll path.
const { authMock } = vi.hoisted(() => ({
  authMock: { authenticated: true },
}));
vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

import type { FeedActivityItem } from "../../../api/client-types-feed";
import type { WidgetProps } from "../../../widgets/types";

const { getFeedAgentActivityMock, openViewMock } = vi.hoisted(() => ({
  getFeedAgentActivityMock: vi.fn(),
  openViewMock: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: {
    getFeedAgentActivity: getFeedAgentActivityMock,
  },
}));

// Isolate the widget from app state: stub navigation so we can assert the
// view it opens without an AppContext provider.
vi.mock("./home-widget-card", async () => {
  const actual =
    await vi.importActual<typeof import("./home-widget-card")>(
      "./home-widget-card",
    );
  return {
    ...actual,
    useWidgetNavigation: () => ({
      openView: openViewMock,
      openTab: vi.fn(),
    }),
  };
});

import { AgentActivityWidget } from "./agent-activity";

function activity(overrides: Partial<FeedActivityItem> = {}): FeedActivityItem {
  return {
    id: "a-1",
    type: "post",
    timestamp: "2025-01-01T00:00:00.000Z",
    summary: "Posted about markets",
    ...overrides,
  };
}

const homeProps: Partial<WidgetProps> = {
  slot: "home",
  spanClassName: "col-span-2 row-span-1",
};

describe("AgentActivityWidget", () => {
  beforeEach(() => {
    authMock.authenticated = true;
    getFeedAgentActivityMock.mockReset();
    openViewMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a loading state before the first fetch settles", () => {
    // Never resolves — the widget must show the loading card, not nothing.
    getFeedAgentActivityMock.mockReturnValue(new Promise(() => {}));

    render(<AgentActivityWidget {...homeProps} />);

    const card = screen.getByTestId("chat-widget-agent-activity");
    expect(card.textContent).toContain("Loading");
  });

  it("shows the most-recent activity summary plus a +N badge", async () => {
    getFeedAgentActivityMock.mockResolvedValue({
      items: [
        activity({ id: "a-1", summary: "Bought DEGEN" }),
        activity({ id: "a-2", summary: "Commented on a post" }),
        activity({ id: "a-3", summary: "Posted an update" }),
      ],
      total: 3,
    });

    render(<AgentActivityWidget {...homeProps} />);

    const card = await screen.findByTestId("chat-widget-agent-activity");
    // The single latest datum is shown; the rest collapse into "+N".
    expect(card.textContent).toContain("Bought DEGEN");
    expect(card.textContent).not.toContain("Commented on a post");
    expect(card.textContent).toContain("+2");
    expect(card.getAttribute("aria-label")).toMatch(/Bought DEGEN/);
  });

  it("falls back to contentPreview when summary is absent", async () => {
    getFeedAgentActivityMock.mockResolvedValue({
      items: [
        activity({
          summary: undefined,
          contentPreview: "gm to the timeline",
        }),
      ],
      total: 1,
    });

    render(<AgentActivityWidget {...homeProps} />);

    const card = await screen.findByTestId("chat-widget-agent-activity");
    expect(card.textContent).toContain("gm to the timeline");
    // Single item -> no "+N" badge.
    expect(card.textContent).not.toContain("+");
  });

  it("opens the feed view when activated", async () => {
    getFeedAgentActivityMock.mockResolvedValue({
      items: [activity({ summary: "Posted about markets" })],
      total: 1,
    });

    render(<AgentActivityWidget {...homeProps} />);

    const card = await screen.findByTestId("chat-widget-agent-activity");
    card.click();
    expect(openViewMock).toHaveBeenCalledWith("/apps/feed", "feed");
  });

  it("renders nothing after a settled load with zero items (zero-setup, no placeholder)", async () => {
    getFeedAgentActivityMock.mockResolvedValue({ items: [], total: 0 });

    const { container } = render(<AgentActivityWidget {...homeProps} />);

    await waitFor(() => {
      expect(screen.queryByText("Loading…")).toBeNull();
    });
    expect(screen.queryByTestId("chat-widget-agent-activity")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("settles to empty (renders nothing) when the request fails", async () => {
    getFeedAgentActivityMock.mockRejectedValue(new Error("offline"));

    const { container } = render(<AgentActivityWidget {...homeProps} />);

    await waitFor(() => {
      expect(screen.queryByTestId("chat-widget-agent-activity")).toBeNull();
    });
    expect(container.firstChild).toBeNull();
  });

  it("applies the received spanClassName to its root grid item", async () => {
    getFeedAgentActivityMock.mockResolvedValue({
      items: [activity({ summary: "Posted about markets" })],
      total: 1,
    });

    const { container } = render(
      <AgentActivityWidget spanClassName="col-span-2 row-span-1" />,
    );

    await screen.findByTestId("chat-widget-agent-activity");
    const root = container.firstElementChild;
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
  });
});
