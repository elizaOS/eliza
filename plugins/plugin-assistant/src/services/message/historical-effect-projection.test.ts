import { type ContextObject, normalizeEffectReceipt } from "@elizaos/core";
import { expect, it } from "vitest";
import {
  applyHistoryRetentionReview,
  prepareHistoryRetention,
} from "../../runtime/history-retention.ts";
import {
  loadHistoryReferences,
  projectBackgroundHistory,
  projectReviewedHistory,
  withBackgroundHistory,
} from "./history-discovery.ts";

function fixture() {
  const scope = {
    agentId: "agent",
    roomId: "room",
    entityId: "owner",
    roles: ["OWNER"],
  };
  const base = {
    receiptId: "receipt",
    operation: "record.create",
    resource: { kind: "record", id: "saved" },
    artifacts: [],
    idempotency: { key: "operation", replayed: false },
    observedAt: "2026-10-25T00:00:00.000Z",
  };
  const applied = normalizeEffectReceipt({
    ...base,
    outcome: "applied",
    commit: { kind: "durable", id: "commit", committedAt: base.observedAt },
  });
  const effects = (id: string, receipt: unknown, success = true) => ({
    id: `effect:${id}`,
    type: "segment",
    source: "message-service",
    segment: {
      id: `effect:${id}`,
      label: "runtime:historical_effects",
      content: JSON.stringify({
        requestSourceEventId: `history:${id}`,
        scope: "Past outcomes, not new permission.",
        outcomes: [{ actionName: "RECORD", success, receipt }],
      }),
      stable: false,
    },
  });
  const history = Array.from({ length: 40 }, (_, i) => ({
    id: `history:${i}`,
    type: "segment",
    source: "prior-dialogue",
    segment: {
      id: `history:${i}`,
      label: i % 2 ? "prior_message:agent" : "prior_message:user",
      content: `Original request ${i}`,
      stable: false,
      metadata: { roomId: "room", entityId: i % 2 ? "agent" : "owner" },
    },
  }));
  const context = {
    id: "current-turn",
    metadata: { roomId: "room", messageId: "current" },
    events: [
      ...history,
      effects("0", applied), // retained constraint/referent source
      effects("2", { ...applied, receiptId: "settled" }),
      effects(
        "4",
        normalizeEffectReceipt({
          ...base,
          receiptId: "preview",
          outcome: "preview",
        }),
      ),
      effects(
        "6",
        normalizeEffectReceipt({
          ...base,
          receiptId: "uncertain",
          outcome: "failed",
          failure: { code: "TIMEOUT", retryable: true, acceptance: "unknown" },
        }),
        false,
      ),
      effects("8", { ...applied, unexpected: "unfamiliar" }),
      effects("38", { ...applied, receiptId: "unreviewed" }),
      {
        id: "current-result",
        type: "segment",
        source: "tool",
        segment: {
          id: "current-result",
          label: "tool:current",
          content: "Current effect receipt must remain",
          stable: false,
        },
      },
    ],
  } as ContextObject;
  // Only 36 sources are reviewed. Newer requests are not covered by this checkpoint.
  const prepared = prepareHistoryRetention(
    context,
    scope,
    null,
    "evidence",
    36,
  );
  const checkpoint = applyHistoryRetentionReview(prepared, {
    sourceSetId: prepared.sourceSetId,
    complete: true,
    retainSourceIds: ["h1", "h5", "h7", "h9"],
    deferSourceIds: prepared.candidates
      .filter((s) => !["h1", "h5", "h7", "h9"].includes(s.id))
      .map((s) => s.id),
    uncertainSourceIds: [],
    dependencyGroups: [],
  });
  const discovery = projectReviewedHistory(context, scope, checkpoint);
  if (!discovery) throw new Error("Expected reviewed history projection");
  return { context, scope, checkpoint, discovery };
}

it("defers only validated settled historical effects with their reviewed request", () => {
  const f = fixture(),
    before = structuredClone(f.context),
    full = withBackgroundHistory(f.context, f.discovery),
    projected = projectBackgroundHistory(full);
  const ids = projected.context.events.map((e) => e.id);
  expect(projected.applied).toBe(true);
  expect(ids.includes("effect:2")).toBe(false);
  for (const id of [
    "history:0",
    "history:4",
    "history:6",
    "history:8",
    "effect:0",
    "effect:4",
    "effect:6",
    "effect:8",
    "effect:38",
    "current-result",
  ])
    expect(ids.includes(id)).toBe(true);
  expect(f.context).toEqual(before);
});

it("full history restoration returns the original settled receipt unchanged", () => {
  const f = fixture();
  const restored = loadHistoryReferences(f.context, f.discovery, [
    "history:all",
  ]);
  const projected = projectBackgroundHistory(
    withBackgroundHistory(f.context, restored.projection),
  );
  expect(projected.context.events).toEqual(f.context.events);
});

it("a stale account-bound checkpoint cannot remove historical effects", () => {
  const f = fixture(),
    full = withBackgroundHistory(f.context, f.discovery);
  const raw = full.metadata?.backgroundHistory as Record<string, unknown>;
  const forged = {
    ...full,
    metadata: {
      ...full.metadata,
      backgroundHistory: {
        ...raw,
        scope: { ...f.scope, entityId: "another-owner" },
      },
    },
  };
  expect(projectBackgroundHistory(forged).applied).toBe(false);
  expect(projectBackgroundHistory(forged).context.events).toEqual(full.events);
});
