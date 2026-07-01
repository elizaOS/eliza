// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("drops malformed items at the boundary and renders only the valid one", async () => {
    // The route is untrusted network input. A leading null / string / item
    // missing a required field (id/type/timestamp) must be filtered out; if the
    // boundary validator regressed, `latest` would be a junk value and
    // describeActivity would throw or render garbage.
    getFeedAgentActivityMock.mockResolvedValue({
      items: [
        null,
        "not-an-object",
        { id: "bad", type: "post" }, // no timestamp
        { type: "post", timestamp: "2025-01-01T00:00:00.000Z" }, // no id
        activity({ id: "ok", summary: "Only valid row" }),
      ],
      total: 5,
    });

    render(<AgentActivityWidget {...homeProps} />);
    const card = await screen.findByTestId("chat-widget-agent-activity");

    expect(card.textContent).toContain("Only valid row");
    // Only 1 item survives filtering; server total (5) >= 1 so total stays 5,
    // giving extraCount = 5 - 1 = 4. Junk rows never inflate the shown datum.
    expect(card.textContent).toContain("+4");
  });

  it("describes a trade with no summary/preview using type + ticker", async () => {
    getFeedAgentActivityMock.mockResolvedValue({
      items: [
        activity({
          type: "trade",
          summary: undefined,
          contentPreview: undefined,
          ticker: "DEGEN",
        }),
      ],
      total: 1,
    });

    render(<AgentActivityWidget {...homeProps} />);
    const card = await screen.findByTestId("chat-widget-agent-activity");
    expect(card.textContent).toContain("trade DEGEN");
  });

  it("falls back to the humanised type when every descriptive field is empty", async () => {
    // Whitespace-only summary/preview must not win — the card must never show a
    // blank value.
    getFeedAgentActivityMock.mockResolvedValue({
      items: [
        activity({
          type: "message",
          summary: "   ",
          contentPreview: "  ",
          ticker: undefined,
        }),
      ],
      total: 1,
    });

    render(<AgentActivityWidget {...homeProps} />);
    const card = await screen.findByTestId("chat-widget-agent-activity");
    const value = card.textContent ?? "";
    expect(value).toContain("message");
    // Never a blank/whitespace-only datum.
    expect(value.trim().length).toBeGreaterThan(0);
  });

  it("clamps a total that is smaller than the returned item count", async () => {
    // Adversarial: server reports total < number of items actually returned.
    // extraCount must derive from the real item count, never go negative.
    getFeedAgentActivityMock.mockResolvedValue({
      items: [
        activity({ id: "a-1", summary: "First" }),
        activity({ id: "a-2", summary: "Second" }),
        activity({ id: "a-3", summary: "Third" }),
      ],
      total: 1,
    });

    render(<AgentActivityWidget {...homeProps} />);
    const card = await screen.findByTestId("chat-widget-agent-activity");
    // total clamps up to items.length (3) -> extraCount = 3 - 1 = 2.
    expect(card.textContent).toContain("First");
    expect(card.textContent).toContain("+2");
    // Never renders a negative badge.
    expect(card.textContent).not.toContain("+-");
    expect(card.textContent).not.toContain("-1");
  });

  it("navigates to the same feed target on rapid double activation (idempotent payload)", async () => {
    getFeedAgentActivityMock.mockResolvedValue({
      items: [activity({ summary: "Posted about markets" })],
      total: 1,
    });

    render(<AgentActivityWidget {...homeProps} />);
    const card = await screen.findByTestId("chat-widget-agent-activity");

    card.click();
    card.click();
    card.click();

    expect(openViewMock).toHaveBeenCalledTimes(3);
    // Every invocation targets the same view + tab — no drift under rapid fire.
    for (const call of openViewMock.mock.calls) {
      expect(call).toEqual(["/apps/feed", "feed"]);
    }
  });

  it("navigates from the loading card too (tap before the first fetch settles)", () => {
    getFeedAgentActivityMock.mockReturnValue(new Promise(() => {}));

    render(<AgentActivityWidget {...homeProps} />);
    const card = screen.getByTestId("chat-widget-agent-activity");
    expect(card.textContent).toContain("Loading");

    card.click();
    expect(openViewMock).toHaveBeenCalledWith("/apps/feed", "feed");
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
