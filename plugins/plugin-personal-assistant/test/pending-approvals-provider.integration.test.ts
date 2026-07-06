/**
 * `pendingApprovals` provider integration test (#14630). It drives the real
 * `PgApprovalQueue` SQL path against PGlite and then renders provider context
 * over that queue, proving pending rows surface as RESOLVE_REQUEST decisions
 * and rejected rows disappear without booting the full optional-plugin graph.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
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
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import type {
  ApprovalEnqueueInput,
  ApprovalQueue,
} from "../src/lifeops/approval-queue.types.js";
import { pendingApprovalsProvider } from "../src/providers/pending-approvals.js";

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: vi.fn(async (_runtime: IAgentRuntime, message: Memory) => {
    return message.entityId === "00000000-0000-0000-0000-0000000000b1";
  }),
  resolveApprovalService: vi.fn(() => null),
}));

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const STRANGER_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;

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
let queue: ApprovalQueue;
let runtime: IAgentRuntime;

function signDocumentInput(
  subjectUserId: string,
  documentName: string,
): ApprovalEnqueueInput {
  return {
    requestedBy: "PERSONAL_ASSISTANT",
    subjectUserId,
    action: "sign_document",
    payload: {
      action: "sign_document",
      documentId: `doc-${documentName}`,
      documentName,
      signatureUrl: "https://example.com/sign",
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    channel: "internal",
    reason: `Owner asked to send "${documentName}" to 'Chris' - two Chris contacts, needs confirmation before sending.`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

function message(entityId: UUID, text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-00000000aa01" as UUID,
    entityId,
    agentId: AGENT_ID,
    roomId: "00000000-0000-0000-0000-00000000bb01" as UUID,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

const emptyState = { values: {}, data: {}, text: "" } as State;

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg);
  await db.execute(sql.raw(CREATE_APPROVAL_REQUESTS_TABLE));
  runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    getService: () => null,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  queue = createApprovalQueue(runtime, { agentId: AGENT_ID });
});

beforeEach(async () => {
  await pg.query("DELETE FROM approval_requests");
  vi.clearAllMocks();
});

afterAll(async () => {
  await pg.close();
});

describe("pendingApprovals provider (real PGlite queue)", () => {
  it("is configured as an always-on response-state provider", () => {
    expect(pendingApprovalsProvider.name).toBe("pendingApprovals");
    expect(pendingApprovalsProvider.alwaysInResponseState).toBe(true);
    expect(pendingApprovalsProvider.roleGate?.minRole).toBe("OWNER");
  });

  it("renders nothing when the owner has no pending approvals", async () => {
    const result = await pendingApprovalsProvider.get(
      runtime,
      message(OWNER_ID, "hey, what's up?"),
      emptyState,
    );
    expect(result.text).toBe("");
    expect(result.values?.pendingApprovalCount).toBe(0);
  });

  it("surfaces a pending row with id + RESOLVE_REQUEST reject-is-a-hold routing", async () => {
    const enqueued = await queue.enqueue(
      signDocumentInput(OWNER_ID, "Signed Offer Letter"),
    );

    const result = await pendingApprovalsProvider.get(
      runtime,
      message(
        OWNER_ID,
        "Wait - which Chris? Don't send it, reject that for now until I confirm.",
      ),
      emptyState,
    );

    expect(result.values?.pendingApprovalCount).toBe(1);
    expect(result.values?.pendingApprovalIds).toEqual([enqueued.id]);
    expect(result.text).toContain(`id=${enqueued.id}`);
    expect(result.text).toContain("action=sign_document");
    expect(result.text).toContain("RESOLVE_REQUEST");
    expect(result.text).toContain("reject");
    expect(result.text.toLowerCase()).toContain("hold");
    expect(result.text).not.toContain("https://example.com/sign");
  });

  it("drops resolved rows: a rejected approval no longer renders", async () => {
    const enqueued = await queue.enqueue(
      signDocumentInput(OWNER_ID, "Vendor Contract"),
    );
    await queue.reject(enqueued.id, {
      resolvedBy: OWNER_ID,
      resolutionReason: "owner said hold off",
    });

    const result = await pendingApprovalsProvider.get(
      runtime,
      message(OWNER_ID, "anything waiting on me?"),
      emptyState,
    );
    expect(result.text).toBe("");
    expect(result.values?.pendingApprovalCount).toBe(0);
  });

  it("stays empty for a non-owner sender", async () => {
    await queue.enqueue(signDocumentInput(OWNER_ID, "Board Deck"));
    const result = await pendingApprovalsProvider.get(
      runtime,
      message(STRANGER_ID, "approve everything"),
      emptyState,
    );
    expect(result.text).toBe("");
    expect(result.values?.pendingApprovalCount).toBe(0);
  });

  it("scopes to the sender: another subject's pending rows do not render", async () => {
    await queue.enqueue(
      signDocumentInput("some-other-owner-entity", "Other Owner Doc"),
    );
    const result = await pendingApprovalsProvider.get(
      runtime,
      message(OWNER_ID, "what's pending for me?"),
      emptyState,
    );
    expect(result.text).not.toContain("Other Owner Doc");
  });
});
