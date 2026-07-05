/**
 * Error-policy proof for the reconcile sweep's provider status-probe boundary
 * (#13415): an internal probe failure must stay DISTINGUISHABLE from a designed
 * terminal state and must never move money blind. Deterministic mock harness —
 * the repository, provider registry, and credits service are mocked so the test
 * observes exactly which money lanes the sweep touches per upstream verdict; it
 * drives the real exported `reconcilePendingVideoGenerations`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Generation } from "../../db/schemas/generations";
import type { VideoJobStatus } from "../providers/video/types";
import { VIDEO_PENDING_SETTLEMENT_MARKER } from "../providers/video/types";

// Recorders for the money lanes: a blind refund/settle on a probe failure would
// register here. Reset per test.
const reconcileCalls: unknown[] = [];
const refundCalls: unknown[] = [];
const generationUpdateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];

let pendingRows: Generation[] = [];
// Controllable upstream probe: returns a verdict or throws (transport failure).
let getJobStatusImpl: () => Promise<VideoJobStatus> = async () => ({ state: "pending" });
let getJobStatusCalls = 0;

function makeGeneration(overrides: Partial<Generation> & { id: string }): Generation {
  const base = {
    organization_id: "org-1",
    user_id: null,
    type: "video",
    model: "fal-ai/veo3",
    provider: "fal",
    prompt: "a lighthouse at dusk",
    status: "pending",
    job_id: "fal-req-1",
    created_at: new Date(),
    metadata: {
      settlement_marker: VIDEO_PENDING_SETTLEMENT_MARKER,
      reservation_transaction_id: "resv-1",
      reserved_amount: 0.5,
      billed_cost: 0.5,
      billing_source: "fal",
    },
  };
  return { ...base, ...overrides } as unknown as Generation;
}

mock.module("../../db/repositories/generations", () => ({
  generationsRepository: {
    listPendingVideoSettlements: async () => pendingRows,
    update: async (id: string, data: Record<string, unknown>) => {
      generationUpdateCalls.push({ id, data });
    },
  },
}));

mock.module("../providers/video/registry", () => ({
  findVideoProvider: (billingSource: string) =>
    billingSource === "fal"
      ? {
          billingSource: "fal",
          generate: async () => {
            throw new Error("stub does not generate");
          },
          getJobStatus: async () => {
            getJobStatusCalls++;
            return await getJobStatusImpl();
          },
        }
      : undefined,
}));

mock.module("./credits", () => ({
  creditsService: {
    reconcile: async (params: unknown) => {
      reconcileCalls.push(params);
      // A settle-at-0 (refund lane) is what the verified-failure path expects.
      return {
        reservedAmount: 0.5,
        actualCost: 0,
        reservationTransactionId: "resv-1",
        settlementTransactionIds: [],
        adjustmentType: "refund" as const,
      };
    },
    refundCredits: async (params: unknown) => {
      refundCalls.push(params);
      return {};
    },
  },
}));

let reconcilePendingVideoGenerations: typeof import("./video-generation-reconcile").reconcilePendingVideoGenerations;

beforeEach(async () => {
  reconcileCalls.length = 0;
  refundCalls.length = 0;
  generationUpdateCalls.length = 0;
  pendingRows = [];
  getJobStatusCalls = 0;
  getJobStatusImpl = async () => ({ state: "pending" });
  ({ reconcilePendingVideoGenerations } = await import("./video-generation-reconcile"));
});

afterEach(() => {
  mock.restore();
});

describe("provider status-probe boundary (error-policy:J1)", () => {
  test("probe transport failure moves NO money and is counted as skipped, not refunded", async () => {
    pendingRows = [makeGeneration({ id: "gen-probe-fail", created_at: new Date(0) })];
    getJobStatusImpl = async () => {
      throw new Error("provider unreachable");
    };

    const stats = await reconcilePendingVideoGenerations({ apiKeys: { FAL_KEY: "k" } });

    // The failure is contained as a distinct "skipped" outcome — never a refund
    // or a charge — and the sweep does not throw (one bad probe can't abort the
    // batch).
    expect(stats).toMatchObject({ scanned: 1, skipped: 1, refunded: 0, charged: 0, expired: 0 });
    expect(getJobStatusCalls).toBe(1);
    // Critically: no money lane fired and the generation row was never mutated.
    expect(reconcileCalls).toHaveLength(0);
    expect(refundCalls).toHaveLength(0);
    expect(generationUpdateCalls).toHaveLength(0);
  });

  test("a verified terminal failure DOES move money — distinct from a probe failure", async () => {
    pendingRows = [makeGeneration({ id: "gen-verified-fail" })];
    getJobStatusImpl = async () => ({ state: "failed", error: "render exploded" });

    const stats = await reconcilePendingVideoGenerations({ apiKeys: { FAL_KEY: "k" } });

    // The designed terminal-failure path settles the hold (refund lane) and
    // marks the row failed — proving "internal probe failure" (money untouched)
    // stays distinguishable from "verified failure" (refunded).
    expect(stats).toMatchObject({ scanned: 1, refunded: 1, skipped: 0, charged: 0 });
    expect(reconcileCalls).toHaveLength(1);
    expect(generationUpdateCalls).toHaveLength(1);
    expect(generationUpdateCalls[0]?.data).toMatchObject({ status: "failed" });
  });

  test("one probe failure does not starve a sibling row's verified verdict", async () => {
    pendingRows = [
      makeGeneration({ id: "gen-a-probe-fail" }),
      makeGeneration({ id: "gen-b-verified-fail" }),
    ];
    let call = 0;
    getJobStatusImpl = async () => {
      call++;
      if (call === 1) throw new Error("provider unreachable");
      return { state: "failed", error: "render exploded" };
    };

    const stats = await reconcilePendingVideoGenerations({ apiKeys: { FAL_KEY: "k" } });

    // First row skipped (probe threw), second row still reconciled — per-item
    // isolation, no swallow that fabricates a batch-wide default.
    expect(stats).toMatchObject({ scanned: 2, skipped: 1, refunded: 1 });
    expect(reconcileCalls).toHaveLength(1);
  });
});
