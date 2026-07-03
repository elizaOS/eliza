// @vitest-environment jsdom
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

function mockInbox(messages: ReturnType<typeof message>[]) {
  const stub = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      messages,
      channelCounts: {},
      fetchedAt: "2026-01-01T00:00:00.000Z",
    }),
  }));
  vi.stubGlobal("fetch", stub);
  return stub;
}

const fetchProps: Partial<WidgetProps> = { slot: "home" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  authMock.authenticated = true;
  getBaseUrlMock.mockReturnValue("http://localhost");
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

  it("does not probe inbox routes on dedicated cloud chat agents", async () => {
    getBaseUrlMock.mockReturnValue(
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
    );
    vi.stubGlobal("fetch", vi.fn());

    const { container } = render(<InboxUnreadWidget {...fetchProps} />);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
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

  // #11084 — the widget mounts before the auth probe resolves; the 20s inbox
  // poll must not fire a single request while the session is unauthenticated.
  it("does not poll the inbox while unauthenticated", async () => {
    authMock.authenticated = false;
    const fetchStub = mockInbox([
      message({ id: "m1", sender: "Dana", priorityScore: 90 }),
    ]);

    const { container } = render(<InboxUnreadWidget {...fetchProps} />);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("starts the inbox poll once the session flips to authenticated", async () => {
    authMock.authenticated = false;
    const fetchStub = mockInbox([
      message({ id: "m1", sender: "Dana", priorityScore: 90 }),
    ]);

    const { rerender } = render(<InboxUnreadWidget {...fetchProps} />);
    await Promise.resolve();
    expect(fetchStub).not.toHaveBeenCalled();

    authMock.authenticated = true;
    rerender(<InboxUnreadWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-inbox-unread")).toBeTruthy();
    });
    expect(fetchStub).toHaveBeenCalled();
  });

  it("applies the host-supplied spanClassName to its single root grid-item element (#11752)", async () => {
    mockInbox([message({ id: "m1", sender: "Dana" })]);

    const { container } = render(
      <InboxUnreadWidget
        {...fetchProps}
        spanClassName="col-span-2 row-span-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-inbox-unread")).toBeTruthy();
    });
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    expect(
      root?.querySelector('[data-testid="chat-widget-inbox-unread"]'),
    ).not.toBeNull();
  });

  it("falls back to the default 2x1 span when no spanClassName is supplied (#11752)", async () => {
    mockInbox([message({ id: "m1", sender: "Dana" })]);

    const { container } = render(<InboxUnreadWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-inbox-unread")).toBeTruthy();
    });
    expect(container.firstElementChild?.className).toContain("col-span-2");
  });
});
