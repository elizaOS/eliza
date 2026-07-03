// @vitest-environment jsdom
import type { PendingUserAction } from "@elizaos/core";
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

const {
  getBaseUrlMock,
  listPendingActionsMock,
  publishHomeAttentionSpy,
  dispatchChatPrefillSpy,
} = vi.hoisted(() => ({
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  listPendingActionsMock: vi.fn(),
  publishHomeAttentionSpy: vi.fn(),
  dispatchChatPrefillSpy: vi.fn(),
}));

// The widget reads the canonical surface through the typed client; mock only
// the one method it calls.
vi.mock("../../../api", () => ({
  client: {
    getBaseUrl: getBaseUrlMock,
    listPendingActions: listPendingActionsMock,
  },
}));

// Spy on the self-signal hook so we can assert the published weight without
// reaching into the store internals.
vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: (widgetKey: string, weight: number | null) =>
    publishHomeAttentionSpy(widgetKey, weight),
}));

// The round-trip hands the user back to the agent's RESOLVE_REQUEST action via a
// prefilled chat composer; spy on that one rail while preserving the module's
// other exports (client-base imports NETWORK_STATUS_CHANGE_EVENT et al.).
vi.mock("../../../events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../events")>()),
  dispatchChatPrefill: dispatchChatPrefillSpy,
}));

import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { NeedsAttentionWidget, STALE_PENDING_AGE_MS } from "./needs-attention";

function pending(
  patch: {
    id: string;
    title?: string;
    ageMs?: number;
  } & Partial<PendingUserAction>,
): PendingUserAction {
  return {
    id: patch.id as PendingUserAction["id"],
    kind: patch.kind ?? "approval",
    source: patch.source ?? "approval-service",
    title: patch.title ?? "Post this tweet?",
    createdAt: Date.now() - (patch.ageMs ?? 0),
    roomId: (patch.roomId ??
      "11111111-1111-1111-1111-111111111111") as PendingUserAction["roomId"],
    options: patch.options,
  };
}

function mockPending(items: PendingUserAction[]): void {
  listPendingActionsMock.mockResolvedValue({ pending: items });
}

const fetchProps: Partial<WidgetProps> = { slot: "home" };
const WIDGET_KEY = "needs-attention/needs-attention.pending";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  authMock.authenticated = true;
  getBaseUrlMock.mockReturnValue("http://localhost");
  publishHomeAttentionSpy.mockReset();
  dispatchChatPrefillSpy.mockReset();
  listPendingActionsMock.mockReset();
});

describe("NeedsAttentionWidget (#9449)", () => {
  it("shows the oldest pending action as a clickable card with a count badge (minimal, icon-first)", async () => {
    mockPending([
      pending({ id: "a-1", title: "Send the contract", ageMs: 60_000 }),
      pending({ id: "a-2", title: "Confirm the deploy", ageMs: 10_000 }),
    ]);

    render(<NeedsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-needs-attention")).toBeTruthy();
    });

    const widget = screen.getByTestId("chat-widget-needs-attention");
    // Whole-card button, minimal: the OLDEST request is the single datum.
    expect(widget.tagName).toBe("BUTTON");
    expect(widget.textContent).toContain("Send the contract");
    expect(widget.textContent).not.toContain("Confirm the deploy");
    // The full meaning lives in the aria-label since visible text is minimal.
    expect(widget.getAttribute("aria-label")).toMatch(
      /2 actions need your response/i,
    );
    expect(widget.getAttribute("aria-label")).toMatch(/Send the contract/);
  });

  it("renders nothing when no actions are pending", async () => {
    mockPending([]);

    const { container } = render(<NeedsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(listPendingActionsMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("chat-widget-needs-attention")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("does not probe approvals on dedicated cloud chat agents", async () => {
    getBaseUrlMock.mockReturnValue(
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
    );

    const { container } = render(<NeedsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(listPendingActionsMock).not.toHaveBeenCalled();
  });

  it("does not update state when the approvals request resolves after unmount", async () => {
    let resolvePending!: (value: { pending: PendingUserAction[] }) => void;
    const request = new Promise<{ pending: PendingUserAction[] }>((resolve) => {
      resolvePending = resolve;
    });
    listPendingActionsMock.mockReturnValueOnce(request);

    const { unmount } = render(<NeedsAttentionWidget {...fetchProps} />);
    await waitFor(() => {
      expect(listPendingActionsMock).toHaveBeenCalled();
    });

    unmount();
    resolvePending({
      pending: [pending({ id: "a-1", title: "Late decision" })],
    });
    await request;

    expect(screen.queryByTestId("chat-widget-needs-attention")).toBeNull();
  });

  it("publishes the approval weight while a fresh decision is pending", async () => {
    mockPending([pending({ id: "a-1", ageMs: 1_000 })]);

    render(<NeedsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-needs-attention")).toBeTruthy();
    });
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      WIDGET_KEY,
      HOME_SIGNAL_WEIGHTS.approval,
    );
  });

  it("escalates the weight once the oldest decision goes stale", async () => {
    mockPending([
      pending({
        id: "a-1",
        title: "Old decision",
        ageMs: STALE_PENDING_AGE_MS + 60_000,
      }),
    ]);

    render(<NeedsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-needs-attention")).toBeTruthy();
    });
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      WIDGET_KEY,
      HOME_SIGNAL_WEIGHTS.escalation,
    );
    // Stale → warn tone marker.
    const widget = screen.getByTestId("chat-widget-needs-attention");
    expect(widget.getAttribute("aria-label")).toMatch(/Old decision/);
  });

  it("routes back to the handler by prefilling chat with an approval on click", async () => {
    mockPending([
      pending({ id: "a-1", title: "Send the contract", ageMs: 5_000 }),
    ]);

    render(<NeedsAttentionWidget {...fetchProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-needs-attention")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("chat-widget-needs-attention"));

    expect(dispatchChatPrefillSpy).toHaveBeenCalledWith({
      text: "Approve: Send the contract",
      select: true,
    });
  });

  // #11084 — the widget mounts before the auth probe resolves; the 20s
  // approvals poll must not fire a single request while unauthenticated.
  it("does not poll pending actions while unauthenticated", async () => {
    authMock.authenticated = false;
    mockPending([pending({ id: "a-1", title: "Send the contract" })]);

    const { container } = render(<NeedsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(listPendingActionsMock).not.toHaveBeenCalled();
  });

  it("starts the approvals poll once the session flips to authenticated", async () => {
    authMock.authenticated = false;
    mockPending([pending({ id: "a-1", title: "Send the contract" })]);

    const { rerender } = render(<NeedsAttentionWidget {...fetchProps} />);
    await Promise.resolve();
    expect(listPendingActionsMock).not.toHaveBeenCalled();

    authMock.authenticated = true;
    rerender(<NeedsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-needs-attention")).toBeTruthy();
    });
    expect(listPendingActionsMock).toHaveBeenCalled();
  });

  it("applies the host-supplied spanClassName to its single root grid-item element (#11752)", async () => {
    mockPending([pending({ id: "a-1", title: "Send the contract" })]);

    const { container } = render(
      <NeedsAttentionWidget
        {...fetchProps}
        spanClassName="col-span-2 row-span-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-needs-attention")).toBeTruthy();
    });
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    expect(
      root?.querySelector('[data-testid="chat-widget-needs-attention"]'),
    ).not.toBeNull();
  });

  it("falls back to the default 2x1 span when no spanClassName is supplied (#11752)", async () => {
    mockPending([pending({ id: "a-1", title: "Send the contract" })]);

    const { container } = render(<NeedsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-needs-attention")).toBeTruthy();
    });
    expect(container.firstElementChild?.className).toContain("col-span-2");
  });
});
