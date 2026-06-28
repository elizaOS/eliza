// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RelationshipsMergeCandidate,
  RelationshipsPersonSummary,
} from "../../../api/client-types-relationships";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";

const {
  getBaseUrlMock,
  getRelationshipsPeopleMock,
  getRelationshipsCandidatesMock,
  publishHomeAttentionMock,
} = vi.hoisted(() => ({
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  getRelationshipsPeopleMock: vi.fn(),
  getRelationshipsCandidatesMock: vi.fn(),
  publishHomeAttentionMock: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: {
    getBaseUrl: getBaseUrlMock,
    getRelationshipsPeople: getRelationshipsPeopleMock,
    getRelationshipsCandidates: getRelationshipsCandidatesMock,
  },
}));

// Keep the interval inert in tests — we only assert on the first load.
vi.mock("../../../hooks", () => ({
  useIntervalWhenDocumentVisible: () => undefined,
}));

// Spy on the self-signal hook so we can assert the weight it's called with.
vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: (widgetKey: string, weight: number | null) =>
    publishHomeAttentionMock(widgetKey, weight),
}));

// useWidgetNavigation → reportUserViewSwitch (from the slash-command controller);
// stub it so the click test isolates the navigation rail (the CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

import { RelationshipsAttentionWidget } from "./relationships-attention";

const WIDGET_KEY = "relationships/relationships.attention";

function person(
  overrides: Partial<RelationshipsPersonSummary> = {},
): RelationshipsPersonSummary {
  return {
    groupId: "g-1",
    primaryEntityId: "e-1",
    memberEntityIds: ["e-1"],
    displayName: "Alex",
    aliases: [],
    platforms: [],
    identities: [],
    emails: [],
    phones: [],
    websites: [],
    preferredCommunicationChannel: null,
    categories: [],
    tags: [],
    factCount: 0,
    relationshipCount: 0,
    isOwner: false,
    profiles: [],
    lastInteractionAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function candidate(
  overrides: Partial<RelationshipsMergeCandidate> = {},
): RelationshipsMergeCandidate {
  return {
    id: "c-1",
    entityA: "e-1",
    entityB: "e-2",
    confidence: 0.9,
    evidence: {},
    status: "pending",
    proposedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const fetchProps: Partial<WidgetProps> = { slot: "home" };

describe("RelationshipsAttentionWidget (#9143)", () => {
  beforeEach(() => {
    getBaseUrlMock.mockReturnValue("http://localhost");
    getRelationshipsPeopleMock.mockReset();
    getRelationshipsCandidatesMock.mockReset();
    publishHomeAttentionMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows ONE high-priority datum — Confirm merge? — when a merge is pending (minimal, icon-first)", async () => {
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [
        person({
          groupId: "g-old",
          displayName: "Old Friend",
          lastInteractionAt: "2020-01-01T00:00:00.000Z",
        }),
      ],
      stats: { totalPeople: 1, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([
      candidate(),
      candidate({ id: "c-2" }),
    ]);

    render(<RelationshipsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-relationships")).toBeTruthy();
    });

    const widget = screen.getByTestId("chat-widget-relationships");
    // The card is a button (whole-card clickable) and minimal: the pending
    // merge wins, the stale contact is NOT shown (only the single datum).
    expect(widget.tagName).toBe("BUTTON");
    expect(widget.textContent).toContain("Confirm merge?");
    expect(widget.textContent).not.toContain("Old Friend");
    // The count is a badge.
    expect(widget.textContent).toContain("2");
    // The full meaning lives in the aria-label since visible text is minimal.
    expect(widget.getAttribute("aria-label")).toMatch(/merge/i);

    // Pending merge -> approval weight published.
    expect(publishHomeAttentionMock).toHaveBeenLastCalledWith(
      WIDGET_KEY,
      HOME_SIGNAL_WEIGHTS.approval,
    );
  });

  it("shows the stalest contact (minimal) + no boost when only contacts exist", async () => {
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [
        person({
          groupId: "g-old",
          displayName: "Old Friend",
          lastInteractionAt: "2020-01-01T00:00:00.000Z",
        }),
        person({
          groupId: "g-new",
          displayName: "Recent Pal",
          lastInteractionAt: "2025-06-01T00:00:00.000Z",
        }),
      ],
      stats: { totalPeople: 2, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([]);

    render(<RelationshipsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-relationships")).toBeTruthy();
    });

    const widget = screen.getByTestId("chat-widget-relationships");
    expect(widget.textContent).not.toContain("Confirm merge?");
    // The stalest (oldest-interaction) contact is the single datum shown.
    expect(widget.textContent).toContain("Old Friend");
    expect(widget.textContent).not.toContain("Recent Pal");
    expect(widget.getAttribute("aria-label")).toMatch(/Old Friend/);

    // Last call carries no positive weight — overdue contacts don't float up.
    const calls = publishHomeAttentionMock.mock.calls.filter(
      ([key]) => key === WIDGET_KEY,
    );
    expect(calls.at(-1)?.[1]).toBeNull();
  });

  it("surfaces a never-interacted contact (lastInteractionAt undefined), not dropping it", async () => {
    // The backend omits lastInteractionAt for contacts with no recorded
    // interaction — these are the *stalest* and must still surface, else the
    // card silently empties whenever no one has an interaction timestamp.
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [
        person({
          groupId: "g-never",
          displayName: "Never Met",
          lastInteractionAt: undefined,
        }),
      ],
      stats: { totalPeople: 1, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([]);

    render(<RelationshipsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-relationships")).toBeTruthy();
    });
    expect(
      screen.getByTestId("chat-widget-relationships").textContent,
    ).toContain("Never Met");
  });

  it("navigates to the Relationships view when the card is clicked", async () => {
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [],
      stats: { totalPeople: 0, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([candidate()]);
    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<RelationshipsAttentionWidget {...fetchProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-relationships")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("chat-widget-relationships"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/relationships");
  });

  it("renders null when there are no people and no pending candidates (#9143)", async () => {
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [],
      stats: { totalPeople: 0, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([]);

    const { container } = render(
      <RelationshipsAttentionWidget {...fetchProps} />,
    );

    await waitFor(() => {
      expect(getRelationshipsCandidatesMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("chat-widget-relationships")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("does not probe relationship routes on dedicated cloud chat agents", async () => {
    getBaseUrlMock.mockReturnValue(
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
    );

    const { container } = render(
      <RelationshipsAttentionWidget {...fetchProps} />,
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(getRelationshipsPeopleMock).not.toHaveBeenCalled();
    expect(getRelationshipsCandidatesMock).not.toHaveBeenCalled();
  });

  it("publishes the approval weight when a merge candidate is pending (urgent)", async () => {
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [],
      stats: { totalPeople: 0, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([candidate()]);

    render(<RelationshipsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(publishHomeAttentionMock).toHaveBeenCalledWith(
        WIDGET_KEY,
        HOME_SIGNAL_WEIGHTS.approval,
      );
    });
    expect(HOME_SIGNAL_WEIGHTS.approval).toBeGreaterThan(0);
  });

  it("publishes null (no boost) when only stale contacts exist (informational)", async () => {
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [person()],
      stats: { totalPeople: 1, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([]);

    render(<RelationshipsAttentionWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-relationships")).toBeTruthy();
    });
    // Last call carries no positive weight — overdue contacts don't float up.
    const calls = publishHomeAttentionMock.mock.calls.filter(
      ([key]) => key === WIDGET_KEY,
    );
    expect(calls.at(-1)?.[1]).toBeNull();
  });

  it("applies the host-supplied spanClassName to its single root grid-item element", async () => {
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [person()],
      stats: { totalPeople: 1, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([]);

    const { container } = render(
      <RelationshipsAttentionWidget
        {...fetchProps}
        spanClassName="col-span-2 row-span-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-relationships")).toBeTruthy();
    });
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    // The grid-span classes land on the single root grid item (static classes).
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    // The naked card button lives inside that root.
    expect(
      root?.querySelector('[data-testid="chat-widget-relationships"]'),
    ).not.toBeNull();
  });

  it("falls back to the default 2x1 span when no spanClassName is supplied", async () => {
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [person()],
      stats: { totalPeople: 1, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([]);

    const { container } = render(
      <RelationshipsAttentionWidget {...fetchProps} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-relationships")).toBeTruthy();
    });
    expect(container.firstElementChild?.className).toContain("col-span-2");
  });
});
