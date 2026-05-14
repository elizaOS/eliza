import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ApprovalRequestEventRow,
  ApprovalRequestRow,
  ApprovalRequestsRepository,
  NewApprovalRequestEvent,
} from "../../db/repositories/approval-requests";
import {
  type ApprovalRequestsService,
  type CreateApprovalRequestInput,
  createApprovalRequestsService,
} from "../../lib/services/approval-requests";

interface RecordedEvent {
  approvalRequestId: string;
  eventName: string;
  redactedPayload?: unknown;
}

function makeRow(overrides: Partial<ApprovalRequestRow> = {}): ApprovalRequestRow {
  return {
    id: "appr_test_1",
    organizationId: "org-1",
    agentId: null,
    userId: null,
    challengeKind: "login",
    challengePayload: { message: "Sign in to Eliza Cloud" },
    expectedSignerIdentityId: null,
    status: "pending",
    signatureText: null,
    signedAt: null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeFakeRepository(seed?: ApprovalRequestRow) {
  const store = new Map<string, ApprovalRequestRow>();
  const events: RecordedEvent[] = [];
  if (seed) store.set(seed.id, seed);
  let idCounter = 0;

  const repo: ApprovalRequestsRepository = {
    async createApprovalRequest(input: unknown): Promise<ApprovalRequestRow> {
      const data = input as Partial<ApprovalRequestRow>;
      const id = data.id ?? `appr_test_${++idCounter}`;
      const now = new Date();
      const row = makeRow({
        ...data,
        id,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
      store.set(id, row);
      return row;
    },
    async getApprovalRequest(id: string): Promise<ApprovalRequestRow | null> {
      return store.get(id) ?? null;
    },
    async listApprovalRequests(filter: unknown): Promise<ApprovalRequestRow[]> {
      const f = (filter ?? {}) as {
        organizationId?: string;
        status?: ApprovalRequestRow["status"];
        challengeKind?: ApprovalRequestRow["challengeKind"];
      };
      return Array.from(store.values()).filter((row) => {
        if (f.organizationId && row.organizationId !== f.organizationId) return false;
        if (f.status && row.status !== f.status) return false;
        if (f.challengeKind && row.challengeKind !== f.challengeKind) return false;
        return true;
      });
    },
    async setApprovalRequestStatus(
      id: string,
      status: ApprovalRequestRow["status"] | null,
      patch?: Partial<ApprovalRequestRow>,
    ): Promise<ApprovalRequestRow | null> {
      const existing = store.get(id);
      if (!existing) return null;
      const next: ApprovalRequestRow = {
        ...existing,
        ...(patch ?? {}),
        ...(status ? { status } : {}),
        updatedAt: new Date(),
      };
      store.set(id, next);
      return next;
    },
    async recordApprovalRequestEvent(
      input: NewApprovalRequestEvent,
    ): Promise<ApprovalRequestEventRow> {
      events.push(input);
      return {
        id: `event_${events.length}`,
        approval_request_id: input.approvalRequestId,
        event_name: input.eventName,
        redacted_payload: input.redactedPayload ?? {},
        occurred_at: new Date(),
      };
    },
    async expirePastApprovalRequests(now: Date): Promise<string[]> {
      const expired: string[] = [];
      for (const [id, row] of store) {
        if (
          row.expiresAt.getTime() <= now.getTime() &&
          (row.status === "pending" || row.status === "delivered")
        ) {
          store.set(id, { ...row, status: "expired", updatedAt: new Date() });
          expired.push(id);
        }
      }
      return expired;
    },
  };

  return { repo, store, events };
}

function invalidCreateInput(input: Record<string, unknown>): CreateApprovalRequestInput {
  return input as unknown as CreateApprovalRequestInput;
}

function createWithInvalidInput(
  service: ApprovalRequestsService,
  input: Record<string, unknown>,
): ReturnType<ApprovalRequestsService["create"]> {
  return service.create(invalidCreateInput(input));
}

describe("approvalRequestsService", () => {
  let fake: ReturnType<typeof makeFakeRepository>;

  beforeEach(() => {
    fake = makeFakeRepository();
  });

  test("create persists request and records approval.created", async () => {
    const service = createApprovalRequestsService({ repository: fake.repo });

    const row = await service.create({
      organizationId: "org-1",
      challengeKind: "login",
      challengePayload: { message: "Sign in" },
    });

    expect(row.organizationId).toBe("org-1");
    expect(row.challengeKind).toBe("login");
    const created = fake.events.find((e) => e.eventName === "approval.created");
    expect(created).toBeDefined();
  });

  test("create rejects missing message", async () => {
    const service = createApprovalRequestsService({ repository: fake.repo });
    await expect(
      createWithInvalidInput(service, {
        organizationId: "org-1",
        challengeKind: "login",
        challengePayload: {},
      }),
    ).rejects.toThrow(/message/);
  });

  test("create rejects wallet signer without walletAddress", async () => {
    const service = createApprovalRequestsService({ repository: fake.repo });
    await expect(
      createWithInvalidInput(service, {
        organizationId: "org-1",
        challengeKind: "signature",
        challengePayload: { message: "x", signerKind: "wallet" },
      }),
    ).rejects.toThrow(/walletAddress/);
  });

  test("markApproved transitions pending → approved with signature", async () => {
    const seed = makeRow({ id: "appr_seed", status: "pending" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createApprovalRequestsService({ repository: fakeSeeded.repo });

    const approved = await service.markApproved({
      approvalRequestId: "appr_seed",
      signatureText: "0xdeadbeef",
      signerIdentityId: "0xabc",
    });

    expect(approved.status).toBe("approved");
    expect(approved.signatureText).toBe("0xdeadbeef");
    expect(approved.signedAt).toBeInstanceOf(Date);
    const event = fakeSeeded.events.find((e) => e.eventName === "approval.approved");
    expect(event).toBeDefined();
    const payload = event?.redactedPayload as Record<string, unknown>;
    expect(payload.signerIdentityId).toBe("0xabc");
    expect(JSON.stringify(payload)).not.toContain("0xdeadbeef");
  });

  test("markApproved rejects already-terminal request", async () => {
    const seed = makeRow({ id: "appr_seed", status: "denied" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createApprovalRequestsService({ repository: fakeSeeded.repo });

    await expect(
      service.markApproved({
        approvalRequestId: "appr_seed",
        signatureText: "x",
        signerIdentityId: "y",
      }),
    ).rejects.toThrow(/terminal status/);
  });

  test("markDenied transitions pending → denied", async () => {
    const seed = makeRow({ id: "appr_seed", status: "pending" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createApprovalRequestsService({ repository: fakeSeeded.repo });

    const denied = await service.markDenied("appr_seed", "user changed mind");
    expect(denied.status).toBe("denied");
    expect(fakeSeeded.events.some((e) => e.eventName === "approval.denied")).toBe(true);
  });

  test("cancel transitions pending → canceled (challenger only)", async () => {
    const service = createApprovalRequestsService({ repository: fake.repo });
    const created = await service.create({
      organizationId: "org-1",
      challengeKind: "login",
      challengePayload: { message: "Sign in" },
    });

    const canceled = await service.cancel(created.id, "org-1", "user requested");
    expect(canceled.status).toBe("canceled");
    expect(fake.events.some((e) => e.eventName === "approval.canceled")).toBe(true);
  });

  test("cancel rejects cross-org access", async () => {
    const seed = makeRow({ id: "appr_seed", status: "pending", organizationId: "org-1" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createApprovalRequestsService({ repository: fakeSeeded.repo });

    await expect(service.cancel("appr_seed", "org-other")).rejects.toThrow(
      /does not belong to organization/,
    );
  });

  test("cancel rejects already-terminal request", async () => {
    const seed = makeRow({ id: "appr_seed", status: "approved" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createApprovalRequestsService({ repository: fakeSeeded.repo });

    await expect(service.cancel("appr_seed", "org-1")).rejects.toThrow(/not cancelable/);
  });

  test("expirePast records approval.expired for each expired id", async () => {
    const past = new Date(Date.now() - 60_000);
    const seed = makeRow({ id: "appr_old", status: "pending", expiresAt: past });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createApprovalRequestsService({ repository: fakeSeeded.repo });

    const expired = await service.expirePast(new Date());
    expect(expired).toEqual(["appr_old"]);
    const event = fakeSeeded.events.find((e) => e.eventName === "approval.expired");
    expect(event?.approvalRequestId).toBe("appr_old");
  });

  test("markDelivered idempotent for non-pending status", async () => {
    const seed = makeRow({ id: "appr_seed", status: "approved" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createApprovalRequestsService({ repository: fakeSeeded.repo });

    const result = await service.markDelivered("appr_seed");
    expect(result.status).toBe("approved");
    expect(fakeSeeded.events).toHaveLength(0);
  });

  test("get returns null for cross-org lookup", async () => {
    const seed = makeRow({ id: "appr_seed", organizationId: "org-1" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createApprovalRequestsService({ repository: fakeSeeded.repo });

    expect(await service.get("appr_seed", "org-1")).not.toBeNull();
    expect(await service.get("appr_seed", "org-other")).toBeNull();
  });
});
