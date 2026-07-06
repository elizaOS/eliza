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
  dispatchChatOpenSpy,
} = vi.hoisted(() => ({
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  listPendingActionsMock: vi.fn(),
  publishHomeAttentionSpy: vi.fn(),
  dispatchChatPrefillSpy: vi.fn(),
  dispatchChatOpenSpy: vi.fn(),
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

// The round-trip hands the user back to the canonical handler via a prefilled
// (or opened) chat composer; spy on those rails while preserving the module's
// other exports (client-base imports NETWORK_STATUS_CHANGE_EVENT et al.).
vi.mock("../../../events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../events")>()),
  dispatchChatPrefill: dispatchChatPrefillSpy,
  dispatchChatOpen: dispatchChatOpenSpy,
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
  dispatchChatOpenSpy.mockReset();
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

// #14737 — tap behavior derives from the pending item's kind + options; the
// blanket "Approve: <title>" prefill only survives for approval-shaped items.
describe("NeedsAttentionWidget kind-aware activation (#14737)", () => {
  async function renderTop(item: PendingUserAction): Promise<HTMLElement> {
    mockPending([item]);
    render(<NeedsAttentionWidget {...fetchProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-needs-attention")).toBeTruthy();
    });
    return screen.getByTestId("chat-widget-needs-attention");
  }

  it("an approval with options expands chips on tap instead of prefilling; Approve chip prefills the approval", async () => {
    const card = await renderTop(
      pending({
        id: "a-1",
        title: "Send the contract",
        options: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject", isCancel: true },
        ],
      }),
    );

    expect(screen.queryByTestId("needs-attention-options")).toBeNull();
    fireEvent.click(card);
    // First tap surfaces the choice chips — nothing is prefilled blind.
    expect(dispatchChatPrefillSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("needs-attention-options")).toBeTruthy();

    fireEvent.click(screen.getByTestId("needs-attention-option-approve"));
    expect(dispatchChatPrefillSpy).toHaveBeenCalledWith({
      text: "Approve: Send the contract",
      select: true,
    });
    // Choosing collapses the chip row.
    expect(screen.queryByTestId("needs-attention-options")).toBeNull();
  });

  it("the Reject chip prefills a rejection, not an approval", async () => {
    const card = await renderTop(
      pending({
        id: "a-1",
        title: "Send the contract",
        options: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject", isCancel: true },
        ],
      }),
    );

    fireEvent.click(card);
    fireEvent.click(screen.getByTestId("needs-attention-option-reject"));
    expect(dispatchChatPrefillSpy).toHaveBeenCalledWith({
      text: "Reject: Send the contract",
      select: true,
    });
  });

  it("a choice-kind item surfaces its real options and a tap prefills the option's label as the answer", async () => {
    const card = await renderTop(
      pending({
        id: "c-1",
        kind: "choice",
        title: "Which time works?",
        options: [
          { id: "tue-3", label: "Tuesday 3pm" },
          { id: "wed-10", label: "Wednesday 10am" },
        ],
      }),
    );

    fireEvent.click(card);
    fireEvent.click(screen.getByTestId("needs-attention-option-wed-10"));
    expect(dispatchChatPrefillSpy).toHaveBeenCalledWith({
      text: "Wednesday 10am",
      select: true,
    });
  });

  it("a pending planner question (no options, free reply) opens the composer WITHOUT the wrong Approve prefill", async () => {
    const card = await renderTop(
      pending({
        id: "p-1",
        kind: "pending_prompt",
        source: "pending-prompts",
        title: "Which time works for the dentist?",
        expectedReplyKind: "text",
      }),
    );

    fireEvent.click(card);
    expect(dispatchChatOpenSpy).toHaveBeenCalledTimes(1);
    expect(dispatchChatPrefillSpy).not.toHaveBeenCalled();
  });

  it("an approval without options keeps the classic natural-language prefill", async () => {
    const card = await renderTop(
      pending({ id: "a-2", title: "Book the flight" }),
    );

    fireEvent.click(card);
    expect(dispatchChatPrefillSpy).toHaveBeenCalledWith({
      text: "Approve: Book the flight",
      select: true,
    });
    expect(dispatchChatOpenSpy).not.toHaveBeenCalled();
  });

  it("second tap on the card collapses the chip row again", async () => {
    const card = await renderTop(
      pending({
        id: "a-1",
        title: "Send the contract",
        options: [{ id: "approve", label: "Approve" }],
      }),
    );

    fireEvent.click(card);
    expect(screen.getByTestId("needs-attention-options")).toBeTruthy();
    fireEvent.click(card);
    expect(screen.queryByTestId("needs-attention-options")).toBeNull();
  });
});
