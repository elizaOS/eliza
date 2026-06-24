// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

// useWidgetNavigation → reportUserViewSwitch (from the slash-command
// controller); stub it so the click test isolates the navigation rail (the
// CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { InboxUnreadWidget } from "./inbox-unread";

// Wire message matching the /api/lifeops/inbox LifeOpsInboxMessage shape
// (packages/shared/src/contracts/personal-assistant.ts).
function message(patch: {
  id: string;
  sender?: string;
  subject?: string | null;
  snippet?: string;
  unread?: boolean;
  priorityScore?: number;
  priorityCategory?: "important" | "planning" | "casual";
}) {
  return {
    id: patch.id,
    channel: "gmail",
    sender: {
      id: "s-1",
      displayName: patch.sender ?? "Alex",
      email: null,
      avatarUrl: null,
    },
    subject: patch.subject ?? null,
    snippet: patch.snippet ?? "",
    receivedAt: "2026-01-01T00:00:00.000Z",
    unread: patch.unread ?? true,
    priorityScore: patch.priorityScore ?? 0,
    priorityCategory: patch.priorityCategory ?? "casual",
  };
}

function mockInbox(messages: ReturnType<typeof message>[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages,
        channelCounts: {},
        fetchedAt: "2026-01-01T00:00:00.000Z",
      }),
    })),
  );
}

const fetchProps: Partial<WidgetProps> = { slot: "home" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  publishHomeAttentionSpy.mockClear();
});

describe("InboxUnreadWidget (#9143)", () => {
  it("shows ONE high-priority datum — the top unread sender — as a clickable card (minimal, icon-first)", async () => {
    mockInbox([
      message({
        id: "m1",
        sender: "Dana",
        subject: "Contract",
        priorityScore: 90,
      }),
      message({ id: "m2", sender: "Sam", priorityScore: 10 }),
      message({ id: "m3", sender: "Read", unread: false }),
    ]);

    render(<InboxUnreadWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-inbox-unread")).toBeTruthy();
    });

    const widget = screen.getByTestId("chat-widget-inbox-unread");
    // The card is a button (whole-card clickable) and minimal: the highest-
    // scored unread sender is the single datum; the count is a badge.
    expect(widget.tagName).toBe("BUTTON");
    expect(widget.textContent).toContain("Dana");
    // The full meaning lives in the aria-label since visible text is minimal.
    expect(widget.getAttribute("aria-label")).toMatch(/2 unread/i);
    expect(widget.getAttribute("aria-label")).toMatch(/Dana/);
  });

  it("renders nothing when there are no unread threads", async () => {
    mockInbox([message({ id: "m1", unread: false })]);

    const { container } = render(<InboxUnreadWidget {...fetchProps} />);

    await waitFor(() => {
      expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("chat-widget-inbox-unread")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("publishes the message weight while unread threads exist", async () => {
    mockInbox([message({ id: "m1", sender: "Dana" })]);

    render(<InboxUnreadWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-inbox-unread")).toBeTruthy();
    });
    expect(publishHomeAttentionSpy).toHaveBeenCalledWith(
      "inbox/inbox.unread",
      HOME_SIGNAL_WEIGHTS.message,
    );
  });

  it("navigates to the Inbox view when the card is clicked", async () => {
    mockInbox([message({ id: "m1", sender: "Dana" })]);

    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<InboxUnreadWidget {...fetchProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-inbox-unread")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("chat-widget-inbox-unread"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/inbox");
  });
});
