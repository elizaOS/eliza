import {
  ChannelType,
  type ContextEvent,
  conversationClientUserMemoryId,
  HISTORICAL_EFFECT_TERMINALS,
  type IAgentRuntime,
  type Memory,
  normalizeEffectReceipt,
  selectHistoricalNavigation,
} from "@elizaos/core";
import { beforeEach, expect, it, vi } from "vitest";
import { appendPriorDialogueEvents } from "./dialogue-context.ts";
import { reconcileHistoricalProposalTerminals } from "./historical-proposal-terminals.ts";

const mocks = vi.hoisted(() => ({ read: vi.fn(), access: vi.fn() }));
vi.mock("../approval/store.ts", () => ({
  readApprovalRequestsForOriginalSources: mocks.read,
}));
vi.mock("@elizaos/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revalidateOwnerExclusiveDisclosure: mocks.access,
}));
const agent = "a0000000-0000-4000-8000-000000000001",
  room = "a0000000-0000-4000-8000-000000000002",
  owner = "a0000000-0000-4000-8000-000000000003";
const runtime = {
  agentId: agent,
  actions: [{ name: "DEVICE_BROWSER_OPEN" }],
} as unknown as IAgentRuntime;
const current = {
  id: "current",
  agentId: agent,
  roomId: room,
  entityId: owner,
  content: { text: "Current request" },
} as Memory;
function fixture() {
  const scope = `${agent}:${room}:${owner}`,
    originals: Memory[] = [],
    rows: Array<{
      id: string;
      requestedBy: string;
      subjectUserId: string;
      action: string;
      idempotencyKey: string;
      state: string;
      updatedAt: Date;
      payload: Record<string, unknown>;
      execution: unknown;
    }> = [];
  for (let i = 0; i < 26; i++) {
    const id = `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      messageId = conversationClientUserMemoryId(scope, "request-" + i),
      key = "key-" + i;
    const receipt = normalizeEffectReceipt({
      receiptId: id,
      operation: "device.browser_navigate",
      resource: { kind: "device.approval", id },
      artifacts: [],
      idempotency: { key, replayed: false },
      observedAt: "2026-10-24T00:00:00.000Z",
      outcome: "preview",
    });
    originals.push({
      id: messageId,
      agentId: agent,
      roomId: room,
      entityId: owner,
      createdAt: i,
      content: {
        text: "Original request " + i,
        source: "client_chat",
        channelType: ChannelType.DM,
        chatIdempotency: {
          version: 1,
          scope,
          clientMessageId: "request-" + i,
          fingerprint: "a".repeat(64),
          outcomeJson: JSON.stringify({
            userMessageId: messageId,
            actionResults: [
              {
                actionName: "DEVICE_BROWSER_OPEN",
                success: true,
                effectReceipts: [receipt],
              },
            ],
          }),
        },
      },
    } as Memory);
    rows.push({
      id,
      requestedBy: agent,
      subjectUserId: "original-owner-account",
      action: "device_action",
      idempotencyKey: key,
      state:
        i < 17
          ? "done"
          : i === 17
            ? "rejected"
            : i < 24
              ? "reconciliation_required"
              : "executing",
      updatedAt: new Date("2026-10-24T01:00:00Z"),
      payload: {
        action: "device_action",
        version: 1,
        installationId: "installation",
        enrollmentId: "enrollment",
        requestMessageId: messageId,
        operation: { type: "browser_navigate", url: "https://example.test/" },
      },
      execution:
        i < 17
          ? {
              attemptId: "attempt-" + i,
              providerIdempotencyKey: key,
              providerReceipt: {
                outcome: "applied",
                operationId: "operation-" + i,
                result: {},
              },
            }
          : null,
    });
  }
  const events: ContextEvent[] = [];
  appendPriorDialogueEvents(
    events,
    runtime,
    {
      data: {
        providers: { RECENT_MESSAGES: { data: { recentMessages: originals } } },
      },
    } as never,
    current,
  );
  return { originals, rows, events };
}
beforeEach(() => {
  mocks.read.mockReset();
  mocks.access.mockReset();
  mocks.access.mockResolvedValue({
    allowed: true,
    audience: { canonicalOwnerEntityId: owner },
  });
});
it("reconciles seventeen completed and one rejected proposal while preserving eight unresolved previews and all originals", async () => {
  const f = fixture(),
    before = structuredClone(f.events);
  mocks.read.mockResolvedValue(f.rows);
  const next = await reconcileHistoricalProposalTerminals(
    runtime,
    current,
    f.events,
    f.originals,
  );
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(
    next.filter((e) => e.id.startsWith("historical-proposal-terminal:")),
  ).toHaveLength(18);
  expect(f.events).toEqual(before);
  const omitted = selectHistoricalNavigation(
    { id: "turn", events: next } as never,
    new Set(),
    { historicalEffects: "settled" },
  );
  expect(
    omitted.events.filter(
      (e) =>
        e.type === "segment" &&
        "segment" in e &&
        e.segment.label === "runtime:historical_effects",
    ),
  ).toHaveLength(8);
  expect(
    next.filter(
      (e) =>
        e.type === "segment" &&
        "segment" in e &&
        e.segment.label === "runtime:historical_effects",
    ),
  ).toHaveLength(44);
  const size = (rows: ContextEvent[]) =>
    Buffer.byteLength(
      JSON.stringify(
        rows.filter(
          (e) =>
            e.type === "segment" &&
            "segment" in e &&
            e.segment.label === "runtime:historical_effects",
        ),
      ),
    );
  const beforeProjection = selectHistoricalNavigation(
    { id: "turn", events: f.events } as never,
    new Set(),
    { historicalEffects: "settled" },
  );
  expect(size(omitted.events)).toBeLessThan(size(beforeProjection.events));
  console.info(
    "HISTORICAL_TERMINAL_MEASUREMENT " +
      JSON.stringify({
        fixtureOnly: true,
        unit: "serialized effect-event bytes",
        before: size(beforeProjection.events),
        after: size(omitted.events),
        originalPreviews: 26,
        resolved: 18,
        unresolved: 8,
      }),
  );
});
it("rejects mismatched source, requester, operation and original idempotency identity", async () => {
  const f = fixture();
  f.rows[0].payload.requestMessageId = "another-message";
  f.rows[1].requestedBy = "another-agent";
  f.rows[2].payload.operation = {
    type: "create_note",
    title: "wrong",
    body: "wrong",
  };
  f.rows[3].idempotencyKey = "another-key";
  mocks.read.mockResolvedValue(f.rows);
  const next = await reconcileHistoricalProposalTerminals(
    runtime,
    current,
    f.events,
    f.originals,
  );
  expect(
    next.filter((e) => e.id.startsWith("historical-proposal-terminal:")),
  ).toHaveLength(14);
});
it("does not query or expose terminal state to another owner or denied audience", async () => {
  const f = fixture();
  mocks.access.mockResolvedValue({
    allowed: true,
    audience: { canonicalOwnerEntityId: "other-owner" },
  });
  expect(
    await reconcileHistoricalProposalTerminals(
      runtime,
      current,
      f.events,
      f.originals,
    ),
  ).toEqual(f.events);
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.access.mockResolvedValue({ allowed: false });
  expect(
    await reconcileHistoricalProposalTerminals(
      runtime,
      current,
      f.events,
      f.originals,
    ),
  ).toEqual(f.events);
});
it("retains all original evidence on storage failure or an ownership change after lookup", async () => {
  const f = fixture();
  mocks.read.mockRejectedValue(new Error("storage unavailable"));
  expect(
    await reconcileHistoricalProposalTerminals(
      runtime,
      current,
      f.events,
      f.originals,
    ),
  ).toEqual(f.events);
  mocks.read.mockResolvedValue(f.rows);
  mocks.access
    .mockResolvedValueOnce({
      allowed: true,
      audience: { canonicalOwnerEntityId: owner },
    })
    .mockResolvedValueOnce({ allowed: false });
  expect(
    await reconcileHistoricalProposalTerminals(
      runtime,
      current,
      f.events,
      f.originals,
    ),
  ).toEqual(f.events);
});
it("serialized status text cannot manufacture the runtime proof needed to defer a preview", async () => {
  const f = fixture();
  mocks.read.mockResolvedValue(f.rows);
  const next = await reconcileHistoricalProposalTerminals(
    runtime,
    current,
    f.events,
    f.originals,
  );
  expect(
    next.some(
      (e) =>
        (e as ContextEvent & { [HISTORICAL_EFFECT_TERMINALS]?: unknown })[
          HISTORICAL_EFFECT_TERMINALS
        ],
    ),
  ).toBe(true);
  const serialized = JSON.parse(JSON.stringify(next));
  const projected = selectHistoricalNavigation(
    { id: "turn", events: serialized } as never,
    new Set(),
    { historicalEffects: "settled" },
  );
  expect(
    projected.events.filter(
      (e) =>
        e.type === "segment" &&
        "segment" in e &&
        e.id.startsWith("historical-effects:"),
    ),
  ).toHaveLength(26);
});

it("full history keeps both the unchanged original previews and later terminal proof", async () => {
  const f = fixture(),
    before = structuredClone(f.events);
  mocks.read.mockResolvedValue(f.rows);
  const next = await reconcileHistoricalProposalTerminals(
    runtime,
    current,
    f.events,
    f.originals,
  );
  const full = selectHistoricalNavigation(
    { id: "turn", events: next } as never,
    new Set(
      f.events.filter((e) => e.source === "prior-dialogue").map((e) => e.id),
    ),
    { historicalEffects: "settled" },
  );
  expect(full.events).toEqual(next);
  expect(f.events).toEqual(before);
});

it("does not settle previews from a changed original owner or unrecognized stored receipt fields", async () => {
  const f = fixture();
  f.originals[0].entityId = "another-owner" as Memory["entityId"];
  const marker = f.originals[1].content.chatIdempotency as {
    outcomeJson: string;
  };
  const stored = JSON.parse(marker.outcomeJson);
  stored.actionResults[0].effectReceipts[0].unknownField = true;
  marker.outcomeJson = JSON.stringify(stored);
  mocks.read.mockResolvedValue(f.rows);
  const next = await reconcileHistoricalProposalTerminals(
    runtime,
    current,
    f.events,
    f.originals,
  );
  expect(
    next.filter((e) => e.id.startsWith("historical-proposal-terminal:")),
  ).toHaveLength(16);
});
