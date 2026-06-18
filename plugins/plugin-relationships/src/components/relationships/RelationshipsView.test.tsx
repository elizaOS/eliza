// @vitest-environment jsdom

/**
 * RelationshipsView is a data-fetching view over the two read-only graph
 * endpoints served by the personal-assistant routes:
 *   GET {base}/api/lifeops/entities       -> { entities: EntityWire[] }
 *   GET {base}/api/lifeops/relationships   -> { relationships: RelationshipWire[] }
 *
 * These tests cover the four-state machine (loading / error / empty / populated)
 * plus the retry, refresh, add-someone, and kind-filter affordances. The fetcher
 * seam is injected so the suite stays offline; `@elizaos/ui` and
 * `@elizaos/ui/agent-surface` are mocked so the instrumented controls render
 * outside a provider.
 *
 * The wire fixtures mirror the PA route DTOs field-for-field (Entity /
 * Relationship from plugin-personal-assistant/src/lifeops/{entities,relationships}/types.ts):
 * entity { entityId, type, preferredName, identities[] }; relationship
 * { relationshipId, fromEntityId, toEntityId, type, metadata, state }.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// jest-dom matchers are NOT installed in this repo, so we assert against real
// DOM nodes / Testing Library queries with plain Vitest matchers (mirrors
// plugin-inbox / plugin-goals view tests).
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import {
  type RelationshipsFetchers,
  RelationshipsView,
} from "./RelationshipsView.tsx";

// ---------------------------------------------------------------------------
// Wire fixtures — mirror the PA route DTOs exactly.
// ---------------------------------------------------------------------------

function entity(
  overrides: {
    entityId?: string;
    type?: string;
    preferredName?: string;
    identities?: {
      platform: string;
      handle: string;
      verified?: boolean;
    }[];
  } = {},
) {
  return {
    entityId: overrides.entityId ?? "ent-1",
    type: overrides.type ?? "person",
    preferredName: overrides.preferredName ?? "Pat Doe",
    fullName: overrides.preferredName ?? "Pat Doe",
    identities: (overrides.identities ?? []).map((identity) => ({
      platform: identity.platform,
      handle: identity.handle,
      displayName: identity.handle,
      verified: identity.verified ?? false,
      confidence: 0.9,
    })),
  };
}

function relationship(
  overrides: {
    relationshipId?: string;
    fromEntityId?: string;
    toEntityId?: string;
    type?: string;
    cadenceDays?: number;
    lastInteractionAt?: string;
  } = {},
) {
  return {
    relationshipId: overrides.relationshipId ?? "rel-1",
    fromEntityId: overrides.fromEntityId ?? "self",
    toEntityId: overrides.toEntityId ?? "ent-1",
    type: overrides.type ?? "colleague_of",
    metadata:
      overrides.cadenceDays === undefined
        ? {}
        : { cadenceDays: overrides.cadenceDays },
    state:
      overrides.lastInteractionAt === undefined
        ? {}
        : { lastInteractionAt: overrides.lastInteractionAt },
  };
}

function makeFetchers(
  overrides: Partial<RelationshipsFetchers> = {},
): RelationshipsFetchers {
  return {
    fetchEntities: async () => ({ entities: [entity()] }),
    fetchRelationships: async () => ({ relationships: [] }),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  sendChatMessage.mockClear();
});

describe("RelationshipsView", () => {
  it("shows the loading state while the first fetch is in flight", () => {
    const never = new Promise<never>(() => {});
    render(
      <RelationshipsView
        fetchers={makeFetchers({
          fetchEntities: () => never,
          fetchRelationships: () => never,
        })}
      />,
    );
    expect(screen.getByTestId("relationships-loading")).toBeTruthy();
  });

  it("renders the populated graph with entity nodes and their edges + real fields", async () => {
    render(
      <RelationshipsView
        fetchers={makeFetchers({
          fetchEntities: async () => ({
            entities: [
              entity({
                entityId: "self",
                type: "person",
                preferredName: "Owner",
              }),
              entity({
                entityId: "ent-pat",
                type: "person",
                preferredName: "Pat Doe",
                identities: [
                  { platform: "discord", handle: "pat#1", verified: true },
                ],
              }),
              entity({
                entityId: "ent-acme",
                type: "organization",
                preferredName: "Acme Corp",
              }),
            ],
          }),
          fetchRelationships: async () => ({
            relationships: [
              relationship({
                relationshipId: "rel-pat",
                fromEntityId: "self",
                toEntityId: "ent-pat",
                type: "colleague_of",
                cadenceDays: 14,
                lastInteractionAt: "2026-06-10T00:00:00.000Z",
              }),
            ],
          }),
        })}
      />,
    );
    expect(await screen.findByTestId("relationships-populated")).toBeTruthy();

    // The self node carries the colleague edge to Pat with cadence + last contact.
    const selfCard = screen.getByTestId("relationships-entity-self");
    expect(within(selfCard).getByText("Pat Doe")).toBeTruthy();
    expect(
      within(selfCard).getByText(/colleague_of · every 14d · last/),
    ).toBeTruthy();

    // Pat's card surfaces the identity claim and its kind badge.
    const patCard = screen.getByTestId("relationships-entity-ent-pat");
    expect(within(patCard).getByText(/discord:pat#1/)).toBeTruthy();
    expect(screen.getByTestId("relationships-entity-ent-acme")).toBeTruthy();
  });

  it("shows the empty state when the graph has no entities (no fabrication)", async () => {
    render(
      <RelationshipsView
        fetchers={makeFetchers({
          fetchEntities: async () => ({ entities: [] }),
          fetchRelationships: async () => ({ relationships: [] }),
        })}
      />,
    );
    expect(await screen.findByTestId("relationships-empty")).toBeTruthy();
    expect(screen.getByText(/No people or relationships yet/i)).toBeTruthy();
    expect(screen.queryByTestId("relationships-populated")).toBeNull();
  });

  it("routes the add-someone affordance through the assistant chat", async () => {
    render(
      <RelationshipsView
        fetchers={makeFetchers({
          fetchEntities: async () => ({ entities: [] }),
          fetchRelationships: async () => ({ relationships: [] }),
        })}
      />,
    );
    await screen.findByTestId("relationships-empty");
    fireEvent.click(screen.getByRole("button", { name: /add someone/i }));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("shows the error state with a Retry that refetches into populated", async () => {
    let attempt = 0;
    const fetchEntities = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return { entities: [entity()] };
    };
    render(<RelationshipsView fetchers={makeFetchers({ fetchEntities })} />);
    expect(await screen.findByTestId("relationships-error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByTestId("relationships-populated")).toBeTruthy();
  });

  it("surfaces a relationships-endpoint failure as the error state", async () => {
    render(
      <RelationshipsView
        fetchers={makeFetchers({
          fetchRelationships: async () => {
            throw new Error("relationships down");
          },
        })}
      />,
    );
    expect(await screen.findByTestId("relationships-error")).toBeTruthy();
    expect(screen.getByText(/relationships down/i)).toBeTruthy();
  });

  it("refetches when the header refresh control is activated", async () => {
    let entityCalls = 0;
    let relationshipCalls = 0;
    const fetchers = makeFetchers({
      fetchEntities: async () => {
        entityCalls += 1;
        return { entities: [entity()] };
      },
      fetchRelationships: async () => {
        relationshipCalls += 1;
        return { relationships: [] };
      },
    });
    render(<RelationshipsView fetchers={fetchers} />);
    await screen.findByTestId("relationships-populated");
    expect(entityCalls).toBe(1);
    expect(relationshipCalls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(entityCalls).toBe(2));
    expect(relationshipCalls).toBe(2);
  });

  it("narrows the visible entity cards when a kind filter chip is toggled", async () => {
    render(
      <RelationshipsView
        fetchers={makeFetchers({
          fetchEntities: async () => ({
            entities: [
              entity({
                entityId: "ent-pat",
                type: "person",
                preferredName: "Pat Doe",
              }),
              entity({
                entityId: "ent-acme",
                type: "organization",
                preferredName: "Acme Corp",
              }),
            ],
          }),
        })}
      />,
    );
    await screen.findByTestId("relationships-populated");
    expect(screen.getByTestId("relationships-entity-ent-pat")).toBeTruthy();
    expect(screen.getByTestId("relationships-entity-ent-acme")).toBeTruthy();

    // Toggle the "Organizations" filter: only the org card should remain.
    fireEvent.click(screen.getByRole("button", { name: "Organizations" }));
    await waitFor(() =>
      expect(screen.queryByTestId("relationships-entity-ent-pat")).toBeNull(),
    );
    expect(screen.getByTestId("relationships-entity-ent-acme")).toBeTruthy();
  });
});
