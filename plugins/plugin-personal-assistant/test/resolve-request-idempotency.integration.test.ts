/**
 * RESOLVE_REQUEST durability against the production agent-side PGlite queue.
 * Deterministic barriers exercise concurrent decisions, while persisted
 * approved/executing rows model crashes on either side of the dispatch claim.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApprovalQueue as createAgentApprovalQueue } from "../../../packages/agent/src/services/approval/store.ts";
import { resolveRequestAction } from "../src/actions/resolve-request.js";
import type {
  ApprovalEnqueueInput,
  ApprovalQueue,
  ApprovalRequest,
} from "../src/lifeops/approval-queue.types.js";

const dispatchState = vi.hoisted(() => ({ sends: 0 }));

vi.mock("../src/actions/lib/messaging-helpers.js", () => ({
  dispatchCrossChannelSend: vi.fn(async () => {
    dispatchState.sends += 1;
    return { text: "sent", success: true, data: {} };
  }),
}));

vi.mock("@elizaos/agent", async () => {
  const stub = await import("./stubs/agent.ts");
  return {
    ...stub,
    hasOwnerAccess: vi.fn(async () => true),
    resolveApprovalService: (runtime: IAgentRuntime) =>
      runtime.getService("eliza_approval"),
  };
});

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;

const CREATE_APPROVAL_REQUESTS_TABLE = `CREATE TABLE approval_requests (
  id uuid PRIMARY KEY NOT NULL,
  state text NOT NULL,
  requested_by text NOT NULL,
  subject_user_id text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  channel text NOT NULL,
  reason text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  resolved_at timestamp with time zone,
  resolved_by text,
  resolution_reason text,
  agent_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL
)`;

let pg: PGlite;
let runtime: IAgentRuntime;
let realQueue: ApprovalQueue;
let activeQueue: unknown;

function sendMessageInput(): ApprovalEnqueueInput {
  return {
    requestedBy: "PERSONAL_ASSISTANT",
    subjectUserId: OWNER_ID,
    action: "send_message",
    payload: {
      action: "send_message",
      recipient: "+15551230000",
      body: "On my way.",
      replyToMessageId: null,
    },
    channel: "sms",
    reason: "Confirm before sending",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

function message(intent: "approve" | "reject", requestId: string): Memory {
  return {
    id: "00000000-0000-0000-0000-00000000aa01" as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text: `${intent} ${requestId}` },
    createdAt: Date.now(),
  } as Memory;
}

async function resolve(
  intent: "approve" | "reject",
  requestId: string,
): Promise<{
  success?: boolean;
  text?: string;
  data?: Record<string, unknown>;
}> {
  const result = await resolveRequestAction.handler(
    runtime,
    message(intent, requestId),
    undefined,
    {
      parameters: { action: intent, requestId },
    } as unknown as Parameters<typeof resolveRequestAction.handler>[3],
    undefined,
  );
  return (result ?? {}) as {
    success?: boolean;
    text?: string;
    data?: Record<string, unknown>;
  };
}

async function stateOf(id: string): Promise<string> {
  const result = await pg.query<{ state: string }>(
    "SELECT state FROM approval_requests WHERE id = $1",
    [id],
  );
  return result.rows[0]?.state ?? "(missing)";
}

function delegateQueue(
  base: ApprovalQueue,
  overrides: Partial<ApprovalQueue> = {},
): ApprovalQueue {
  return {
    enqueue: (input) => base.enqueue(input),
    list: (filter) => base.list(filter),
    byId: (id) => base.byId(id),
    approve: (id, resolution) => base.approve(id, resolution),
    reject: (id, resolution) => base.reject(id, resolution),
    markExecuting: (id) => base.markExecuting(id),
    markDone: (id) => base.markDone(id),
    markExpired: (id) => base.markExpired(id),
    purgeExpired: (now) => base.purgeExpired(now),
    ...overrides,
  };
}

function withDecisionBarrier(base: ApprovalQueue): ApprovalQueue {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const bothArrived = new Promise<void>((resolveBarrier) => {
    release = resolveBarrier;
  });
  const waitForBothDecisions = async (): Promise<void> => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await bothArrived;
  };
  return delegateQueue(base, {
    approve: async (id, resolution) => {
      await waitForBothDecisions();
      return base.approve(id, resolution);
    },
    reject: async (id, resolution) => {
      await waitForBothDecisions();
      return base.reject(id, resolution);
    },
  });
}

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw(CREATE_APPROVAL_REQUESTS_TABLE));

  const approvalService = {
    getQueue: () => activeQueue,
  };
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    getService: (type: string) =>
      type === "eliza_approval" ? approvalService : null,
    getSetting: () => undefined,
    reportError: vi.fn(),
    useModel: vi.fn(async () => "{}"),
  } as unknown as IAgentRuntime;
  realQueue = createAgentApprovalQueue(runtime, {
    agentId: AGENT_ID,
  }) as unknown as ApprovalQueue;
  activeQueue = realQueue;
});

beforeEach(async () => {
  await pg.query("DELETE FROM approval_requests");
  activeQueue = realQueue;
  dispatchState.sends = 0;
  vi.clearAllMocks();
});

afterAll(async () => {
  await pg.close();
});

describe("RESOLVE_REQUEST durable approval execution", () => {
  it("recovers an approved outbox row after a crash before execution claim", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    await realQueue.approve(request.id, {
      resolvedBy: OWNER_ID,
      resolutionReason: "approved before crash",
    });

    expect(await stateOf(request.id)).toBe("approved");
    const recovered = await resolve("approve", request.id);

    expect(recovered.success).toBe(true);
    expect(recovered.data?.state).toBe("done");
    expect(dispatchState.sends).toBe(1);
    expect(await stateOf(request.id)).toBe("done");
  });

  it("never retries an executing row after a crash with unknown external outcome", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    await realQueue.approve(request.id, {
      resolvedBy: OWNER_ID,
      resolutionReason: "approved",
    });
    await realQueue.markExecuting(request.id);

    const recovered = await resolve("approve", request.id);

    expect(recovered.success).toBe(false);
    expect(recovered.data?.error).toBe("APPROVAL_EXECUTION_OUTCOME_UNKNOWN");
    expect(recovered.data?.executed).toBe(false);
    expect(dispatchState.sends).toBe(0);
    expect(await stateOf(request.id)).toBe("executing");
  });

  it("reports only done as completed success and suppresses its replay", async () => {
    const request = await realQueue.enqueue(sendMessageInput());

    const first = await resolve("approve", request.id);
    const replay = await resolve("approve", request.id);

    expect(first.success).toBe(true);
    expect(first.data?.state).toBe("done");
    expect(replay.success).toBe(true);
    expect(replay.data?.state).toBe("done");
    expect(replay.data?.alreadyResolved).toBe(true);
    expect(replay.data?.executed).toBe(false);
    expect(dispatchState.sends).toBe(1);
  });

  it("serializes a forced double-approve race to one destructive dispatch", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    activeQueue = withDecisionBarrier(realQueue);

    const [first, second] = await Promise.all([
      resolve("approve", request.id),
      resolve("approve", request.id),
    ]);

    expect(dispatchState.sends).toBe(1);
    expect(await stateOf(request.id)).toBe("done");
    const dispatchOwners = [first, second].filter(
      (result) =>
        result.success === true && result.data?.alreadyResolved !== true,
    );
    expect(dispatchOwners).toHaveLength(1);
    const duplicate = [first, second].find(
      (result) => !dispatchOwners.includes(result),
    );
    expect(duplicate?.data?.executed).toBe(false);
    if (duplicate?.success) {
      expect(duplicate.data?.alreadyResolved).toBe(true);
    } else {
      expect(duplicate?.data?.error).toBe("APPROVAL_EXECUTION_OUTCOME_UNKNOWN");
    }
  });

  it("awaits a forced approve/reject race and preserves the winning decision", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    activeQueue = withDecisionBarrier(realQueue);

    const [approved, rejected] = await Promise.all([
      resolve("approve", request.id),
      resolve("reject", request.id),
    ]);

    const finalState = await stateOf(request.id);
    expect(["done", "rejected"]).toContain(finalState);
    expect(dispatchState.sends).toBe(finalState === "done" ? 1 : 0);
    expect(
      [approved, rejected].filter((result) => result.success),
    ).toHaveLength(1);
    const loser = [approved, rejected].find((result) => !result.success);
    expect([
      "APPROVAL_DECISION_CONFLICT",
      "APPROVAL_EXECUTION_OUTCOME_UNKNOWN",
    ]).toContain(loser?.data?.error);
    expect(loser?.data?.executed).toBe(false);
  });

  it("makes a repeated rejection a successful no-op without dispatch", async () => {
    const request = await realQueue.enqueue(sendMessageInput());

    const first = await resolve("reject", request.id);
    const replay = await resolve("reject", request.id);

    expect(first.success).toBe(true);
    expect(replay.success).toBe(true);
    expect(replay.data?.alreadyResolved).toBe(true);
    expect(await stateOf(request.id)).toBe("rejected");
    expect(dispatchState.sends).toBe(0);
  });

  it("fails early when a legacy service queue has no byId capability", async () => {
    activeQueue = {
      list: realQueue.list.bind(realQueue),
      approve: realQueue.approve.bind(realQueue),
      reject: realQueue.reject.bind(realQueue),
      markExecuting: realQueue.markExecuting.bind(realQueue),
      markDone: realQueue.markDone.bind(realQueue),
    };

    const result = await resolve(
      "approve",
      "00000000-0000-0000-0000-0000000000ff",
    );

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("APPROVAL_QUEUE_INCOMPATIBLE");
    expect(result.data?.missingMethods).toEqual(["byId"]);
  });

  it("does not accept a structurally spoofed transition error", async () => {
    const request = await realQueue.enqueue(sendMessageInput());
    const spoof = Object.assign(new Error("forged transition"), {
      name: "ApprovalStateTransitionError",
      requestId: request.id,
      from: "pending",
      to: "approved",
    });
    activeQueue = delegateQueue(realQueue, {
      approve: async (): Promise<ApprovalRequest> => {
        throw spoof;
      },
    });

    await expect(resolve("approve", request.id)).rejects.toBe(spoof);
    expect(dispatchState.sends).toBe(0);
    expect(await stateOf(request.id)).toBe("pending");
  });

  it("returns a typed denial for an unknown request", async () => {
    const result = await resolve(
      "approve",
      "00000000-0000-0000-0000-0000000000ff",
    );

    expect(result.success).toBe(false);
    expect(result.data?.error).toBe("REQUEST_NOT_FOUND");
    expect(dispatchState.sends).toBe(0);
  });
});
