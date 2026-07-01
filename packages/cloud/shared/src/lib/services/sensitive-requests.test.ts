/**
 * Unit tests for the token-actor (out-of-band, sessionless) paths on
 * `SensitiveRequestsService`:
 *   - `getPublicByToken` — token-gated redacted read for the hosted request page.
 *   - `submit` with a token and no actor — allowed only when the request policy
 *     does not require an authenticated link.
 *
 * Pure service tests with an in-memory repository — no DB, no Worker.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type {
  NewSensitiveRequest,
  NewSensitiveRequestEvent,
  SensitiveRequest,
  SensitiveRequestEvent,
  SensitiveRequestStatus,
  SensitiveRequestWithEvents,
} from "../../db/repositories/sensitive-requests";
import {
  type SensitiveRequestsRepositoryLike,
  SensitiveRequestsService,
} from "./sensitive-requests";

const ORG_ID = "00000000-0000-4000-8000-000000000001";

class InMemoryRepo implements SensitiveRequestsRepositoryLike {
  private requests = new Map<string, SensitiveRequest>();
  private events: SensitiveRequestEvent[] = [];
  private seq = 0;

  async create(data: NewSensitiveRequest): Promise<SensitiveRequest> {
    const id = data.id ?? `req-${++this.seq}`;
    const now = new Date();
    const row: SensitiveRequest = {
      id,
      kind: data.kind,
      status: data.status ?? "pending",
      organization_id: data.organization_id ?? null,
      agent_id: data.agent_id,
      owner_entity_id: data.owner_entity_id ?? null,
      requester_entity_id: data.requester_entity_id ?? null,
      source_room_id: data.source_room_id ?? null,
      source_channel_type: data.source_channel_type ?? null,
      source_platform: data.source_platform ?? null,
      target: data.target,
      policy: data.policy,
      delivery: data.delivery,
      callback: data.callback ?? {},
      token_hash: data.token_hash ?? null,
      token_used_at: data.token_used_at ?? null,
      expires_at: data.expires_at,
      fulfilled_at: data.fulfilled_at ?? null,
      canceled_at: data.canceled_at ?? null,
      expired_at: data.expired_at ?? null,
      created_by: data.created_by ?? null,
      created_at: now,
      updated_at: now,
    };
    this.requests.set(id, row);
    return row;
  }

  async findById(id: string): Promise<SensitiveRequest | undefined> {
    return this.requests.get(id);
  }

  async findWithEvents(id: string): Promise<SensitiveRequestWithEvents | undefined> {
    const request = this.requests.get(id);
    if (!request) return undefined;
    return { request, events: await this.listEvents(id) };
  }

  async update(
    id: string,
    data: Partial<NewSensitiveRequest>,
  ): Promise<SensitiveRequest | undefined> {
    const existing = this.requests.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...data, updated_at: new Date() } as SensitiveRequest;
    this.requests.set(id, next);
    return next;
  }

  async transitionStatus(
    id: string,
    fromStatuses: SensitiveRequestStatus[],
    status: SensitiveRequestStatus,
    data: Partial<NewSensitiveRequest> = {},
  ): Promise<SensitiveRequest | undefined> {
    const existing = this.requests.get(id);
    if (!existing || !fromStatuses.includes(existing.status)) return undefined;
    return this.update(id, { ...data, status });
  }

  async markTokenUsed(id: string): Promise<SensitiveRequest | undefined> {
    const existing = this.requests.get(id);
    if (!existing || existing.token_used_at) return undefined;
    return this.update(id, { token_used_at: new Date() });
  }

  async appendEvent(data: NewSensitiveRequestEvent): Promise<SensitiveRequestEvent> {
    const event: SensitiveRequestEvent = {
      id: `evt-${++this.seq}`,
      request_id: data.request_id,
      organization_id: data.organization_id ?? null,
      event_type: data.event_type,
      actor_type: data.actor_type ?? "system",
      actor_id: data.actor_id ?? null,
      metadata: data.metadata ?? {},
      created_at: new Date(),
    };
    this.events.push(event);
    return event;
  }

  async listEvents(requestId: string): Promise<SensitiveRequestEvent[]> {
    return this.events.filter((event) => event.request_id === requestId);
  }
}

let repo: InMemoryRepo;
let fulfilledFields: Record<string, string> | null;

function buildService(): SensitiveRequestsService {
  fulfilledFields = null;
  return new SensitiveRequestsService({
    repository: repo,
    fulfillPrivateInfo: async ({ fields }) => {
      fulfilledFields = fields;
    },
  });
}

beforeEach(() => {
  repo = new InMemoryRepo();
});

describe("SensitiveRequestsService — token-actor paths", () => {
  test("getPublicByToken returns the redacted public view for a valid token", async () => {
    const service = buildService();
    const created = await service.create(
      {
        kind: "private_info",
        agentId: "agent-1",
        organizationId: ORG_ID,
        target: {
          kind: "private_info",
          fields: [{ name: "shipping_address", required: true }],
        },
        // No authenticated link required → this is a public token link.
        policy: { requireAuthenticatedLink: false, requirePrivateDelivery: false },
      },
      { type: "user", userId: "user-1", organizationId: ORG_ID },
    );

    const view = await service.getPublicByToken(created.request.id, created.submitToken);
    expect(view.id).toBe(created.request.id);
    expect(view.kind).toBe("private_info");
    expect(view.status).toBe("pending");
    // Public view carries no audit array (that is the private view's field).
    expect("audit" in view).toBe(false);
  });

  test("getPublicByToken rejects an invalid token", async () => {
    const service = buildService();
    const created = await service.create(
      {
        kind: "private_info",
        agentId: "agent-1",
        organizationId: ORG_ID,
        target: {
          kind: "private_info",
          fields: [{ name: "shipping_address", required: true }],
        },
        policy: { requireAuthenticatedLink: false, requirePrivateDelivery: false },
      },
      { type: "user", userId: "user-1", organizationId: ORG_ID },
    );

    await expect(service.getPublicByToken(created.request.id, "sr_wrong-token")).rejects.toThrow(
      /Invalid or expired sensitive request token/,
    );
  });

  test("submit with a token and no actor succeeds when the link is not authenticated", async () => {
    const service = buildService();
    const created = await service.create(
      {
        kind: "private_info",
        agentId: "agent-1",
        organizationId: ORG_ID,
        target: {
          kind: "private_info",
          fields: [{ name: "shipping_address", required: true }],
        },
        policy: { requireAuthenticatedLink: false, requirePrivateDelivery: false },
      },
      { type: "user", userId: "user-1", organizationId: ORG_ID },
    );

    const result = await service.submit({
      id: created.request.id,
      token: created.submitToken,
      fields: { shipping_address: "123 Main St" },
    });

    expect(result.status).toBe("fulfilled");
    expect(fulfilledFields).toEqual({ shipping_address: "123 Main St" });
  });

  test("submit with a token but no actor is rejected when the link requires authentication", async () => {
    const service = buildService();
    // Default private_info policy keeps requireAuthenticatedLink: true.
    const created = await service.create(
      {
        kind: "private_info",
        agentId: "agent-1",
        organizationId: ORG_ID,
        target: {
          kind: "private_info",
          fields: [{ name: "shipping_address", required: true }],
        },
      },
      { type: "user", userId: "user-1", organizationId: ORG_ID },
    );

    await expect(
      service.submit({
        id: created.request.id,
        token: created.submitToken,
        fields: { shipping_address: "123 Main St" },
      }),
    ).rejects.toThrow(/Authentication required/);
  });
});
