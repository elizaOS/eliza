/**
 * @vitest-environment jsdom
 *
 * Drives the RelationshipsView GUI data wrapper through the rendered DOM. It is
 * a read-only entity/relationship graph viewer over the
 * two endpoints the personal-assistant routes serve:
 *   GET {base}/api/lifeops/entities       -> { entities: EntityWire[] }
 *   GET {base}/api/lifeops/relationships   -> { relationships: RelationshipWire[] }
 *
 * The default fetchers hit those URLs via `client.getBaseUrl()`; every test here
 * injects the `fetchers` seam so the suite stays offline. We assert the rendered
 * spatial DOM across the four states (loading / error / empty / populated), plus
 * the add-someone, open-entity, retry, and quiet background-poll affordances —
 * all addressed through the agent surface (`data-agent-id`).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// RelationshipsView only touches client.getBaseUrl and sendChatMessage here.
// `client.sendChatMessage()` (add-someone + open-entity affordances). The
// spatial primitives come from the separate `@elizaos/ui/spatial` subpath, which
// is not mocked.
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
}));

import {
  type RelationshipsFetchers,
  RelationshipsView,
} from "./RelationshipsView.js";

// ---------------------------------------------------------------------------
// Wire fixtures — mirror the PA route DTOs exactly.
// ---------------------------------------------------------------------------

function entity(
  overrides: {
    entityId?: string;
    type?: string;
    preferredName?: string;
    identities?: { platform: string; handle: string; verified?: boolean }[];
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

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  sendChatMessage.mockClear();
});

describe("RelationshipsView — states", () => {
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
    expect(screen.getByText("Loading relationships")).toBeTruthy();
  });

  it("renders the populated graph with entity nodes and their edges", async () => {
    const { container } = render(
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

    await screen.findByText("Owner");
    const root = container.querySelector(
      '[data-spatial-kind="box"]',
    ) as HTMLElement;
    expect(root.style.flexShrink).toBe("0");
    expect(root.style.width).toBe("100%");
    // The self node carries the colleague edge to Pat with cadence + last contact.
    expect(agent("rel-self")).toBeTruthy();
    expect(screen.getByText(/colleague_of · every 14d · last/)).toBeTruthy();
    // Pat's node surfaces the identity claim.
    expect(screen.getByText("discord:pat#1")).toBeTruthy();
    expect(agent("rel-ent-acme")).toBeTruthy();
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
    await screen.findByText("None");
    expect(screen.queryByText("Pat Doe")).toBeNull();
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
    await screen.findByText("None");
    fireEvent.click(agent("add"));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("routes the open-entity affordance through the assistant chat", async () => {
    render(
      <RelationshipsView
        fetchers={makeFetchers({
          fetchEntities: async () => ({
            entities: [
              entity({ entityId: "ent-pat", preferredName: "Pat Doe" }),
            ],
          }),
        })}
      />,
    );
    await screen.findByText("Pat Doe");
    fireEvent.click(agent("open-ent-pat"));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("shows the error state with a Retry that refetches into populated", async () => {
    let attempt = 0;
    const fetchEntities = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return { entities: [entity({ preferredName: "Pat Doe" })] };
    };
    render(<RelationshipsView fetchers={makeFetchers({ fetchEntities })} />);
    await screen.findByText("boom");
    fireEvent.click(agent("retry"));
    await screen.findByText("Pat Doe");
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
    await screen.findByText("relationships down");
  });
});

describe("RelationshipsView — filtering + freshness", () => {
  it("narrows the visible entity nodes when a kind filter chip is toggled", async () => {
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
    await screen.findByText("Pat Doe");
    expect(screen.getByText("Acme Corp")).toBeTruthy();

    // Toggle the Organizations filter: only the org node should remain.
    fireEvent.click(agent("relationships-kind-organization"));
    await waitFor(() => expect(screen.queryByText("Pat Doe")).toBeNull());
    expect(screen.getByText("Acme Corp")).toBeTruthy();
  });

  it("refetches both endpoints on the background poll without manual interaction", async () => {
    vi.useFakeTimers();
    try {
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
      // Flush the initial mount fetch.
      await vi.advanceTimersByTimeAsync(0);
      expect(entityCalls).toBe(1);
      expect(relationshipCalls).toBe(1);

      // The quiet poll fires on its interval (20s) and refetches both endpoints.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(entityCalls).toBe(2);
      expect(relationshipCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
