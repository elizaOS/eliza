// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RelationshipsMergeCandidate,
  RelationshipsPersonSummary,
} from "../../../api/client-types-relationships";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";

const {
  getRelationshipsPeopleMock,
  getRelationshipsCandidatesMock,
  publishHomeAttentionMock,
} = vi.hoisted(() => ({
  getRelationshipsPeopleMock: vi.fn(),
  getRelationshipsCandidatesMock: vi.fn(),
  publishHomeAttentionMock: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: {
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

describe("RelationshipsAttentionWidget (#9143)", () => {
  beforeEach(() => {
    getRelationshipsPeopleMock.mockReset();
    getRelationshipsCandidatesMock.mockReset();
    publishHomeAttentionMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders pending-merge and stale-contact attention rows from seeded data", async () => {
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
    getRelationshipsCandidatesMock.mockResolvedValue([candidate()]);

    render(
      <RelationshipsAttentionWidget
        slot="home"
        events={[]}
        clearEvents={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-relationships")).toBeTruthy();
    });
    // Section 1: pending merge prompt.
    expect(screen.getByText("Confirm merge?")).toBeTruthy();
    // Section 2: oldest-interaction contact surfaced.
    expect(screen.getByText("Haven't talked to Old Friend")).toBeTruthy();
  });

  it("renders null when there are no people and no pending candidates (#9143)", async () => {
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [],
      stats: { totalPeople: 0, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([]);

    const { container } = render(
      <RelationshipsAttentionWidget
        slot="home"
        events={[]}
        clearEvents={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(getRelationshipsCandidatesMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("chat-widget-relationships")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("publishes the approval weight when a merge candidate is pending (urgent)", async () => {
    getRelationshipsPeopleMock.mockResolvedValue({
      people: [],
      stats: { totalPeople: 0, totalRelationships: 0, totalIdentities: 0 },
    });
    getRelationshipsCandidatesMock.mockResolvedValue([candidate()]);

    render(
      <RelationshipsAttentionWidget
        slot="home"
        events={[]}
        clearEvents={() => undefined}
      />,
    );

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

    render(
      <RelationshipsAttentionWidget
        slot="home"
        events={[]}
        clearEvents={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Haven't talked to Alex")).toBeTruthy();
    });
    // Last call carries no positive weight — overdue contacts don't float up.
    const calls = publishHomeAttentionMock.mock.calls.filter(
      ([key]) => key === WIDGET_KEY,
    );
    expect(calls.at(-1)?.[1]).toBeNull();
  });
});
