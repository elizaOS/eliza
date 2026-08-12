/**
 * Error-policy proof for the music reconcile sweep's provider status-probe
 * boundary (#18436): an internal probe failure must stay DISTINGUISHABLE from
 * a designed terminal state and must never move money blind. Deterministic mock
 * harness — repository, provider registry, and credits service are mocked so
 * the test observes exactly which money lanes the sweep touches per upstream
 * verdict; it drives the real exported `reconcilePendingMusicGenerations`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Generation } from "../../db/schemas/generations";
import type { AudioJobStatus } from "../providers/audio/types";
import { MUSIC_PENDING_SETTLEMENT_MARKER } from "../providers/audio/types";

const reconcileCalls: unknown[] = [];
const refundCalls: unknown[] = [];
const generationUpdateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];

let pendingRows: Generation[] = [];
let getJobStatusImpl: () => Promise<AudioJobStatus> = async () => ({ state: "pending" });
let getJobStatusCalls = 0;

function makeGeneration(overrides: Partial<Generation> & { id: string }): Generation {
  const base = {
    organization_id: "org-1",
    user_id: null,
    type: "music",
    model: "fal-ai/minimax-music/v2.6",
    provider: "fal",
    prompt: "upbeat synthwave",
    status: "pending",
    job_id: "fal-req-1",
    created_at: new Date(),
    metadata: {
      settlement_marker: MUSIC_PENDING_SETTLEMENT_MARKER,
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
    listPendingMusicSettlements: async () => pendingRows,
    update: async (id: string, data: Record<string, unknown>) => {
      generationUpdateCalls.push({ id, data });
    },
  },
}));

mock.module("../providers/audio/registry", () => ({
  findAudioProvider: (billingSource: string) =>
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
      const actualCost =
        typeof params === "object" &&
        params !== null &&
        "actualCost" in params &&
        typeof (params as { actualCost: unknown }).actualCost === "number"
          ? (params as { actualCost: number }).actualCost
          : 0;
      return {
        reservedAmount: 0.5,
        actualCost,
        reservationTransactionId: "resv-1",
        settlementTransactionIds: [],
        adjustmentType: actualCost === 0 ? ("refund" as const) : ("charge" as const),
      };
    },
    refundCredits: async (params: unknown) => {
      refundCalls.push(params);
      return {};
    },
  },
}));

let reconcilePendingMusicGenerations: typeof import("./music-generation-reconcile").reconcilePendingMusicGenerations;

beforeEach(async () => {
  reconcileCalls.length = 0;
  refundCalls.length = 0;
  generationUpdateCalls.length = 0;
  pendingRows = [];
  getJobStatusCalls = 0;
  getJobStatusImpl = async () => ({ state: "pending" });
  ({ reconcilePendingMusicGenerations } = await import("./music-generation-reconcile"));
});

afterEach(() => {
  mock.restore();
});

describe("music provider status-probe boundary (error-policy:J1) #18436", () => {
  test("probe transport failure moves NO money and is counted as skipped, not refunded", async () => {
    pendingRows = [makeGeneration({ id: "gen-probe-fail", created_at: new Date(0) })];
    getJobStatusImpl = async () => {
      throw new Error("provider unreachable");
    };

    const stats = await reconcilePendingMusicGenerations({ apiKeys: { FAL_KEY: "k" } });

    expect(stats).toMatchObject({ scanned: 1, skipped: 1, refunded: 0, charged: 0, expired: 0 });
    expect(getJobStatusCalls).toBe(1);
    expect(reconcileCalls).toHaveLength(0);
    expect(refundCalls).toHaveLength(0);
    expect(generationUpdateCalls).toHaveLength(0);
  });

  test("a verified terminal failure DOES move money — distinct from a probe failure", async () => {
    pendingRows = [makeGeneration({ id: "gen-verified-fail" })];
    getJobStatusImpl = async () => ({ state: "failed", error: "render exploded" });

    const stats = await reconcilePendingMusicGenerations({ apiKeys: { FAL_KEY: "k" } });

    expect(stats).toMatchObject({ scanned: 1, refunded: 1, skipped: 0, charged: 0 });
    expect(reconcileCalls).toHaveLength(1);
    expect(generationUpdateCalls).toHaveLength(1);
    expect(generationUpdateCalls[0]?.data).toMatchObject({ status: "failed" });
  });

  test("late success charges the hold and completes the generation", async () => {
    pendingRows = [makeGeneration({ id: "gen-late-ok" })];
    getJobStatusImpl = async () => ({
      state: "succeeded",
      result: {
        source: "hosted",
        url: "https://fal.media/late.mp3",
        contentType: "audio/mpeg",
        fileSize: 2048,
        requestId: "fal-req-1",
      },
    });

    const stats = await reconcilePendingMusicGenerations({ apiKeys: { FAL_KEY: "k" } });

    expect(stats).toMatchObject({ scanned: 1, charged: 1, refunded: 0, skipped: 0 });
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]).toMatchObject({ actualCost: 0.5 });
    expect(generationUpdateCalls).toHaveLength(1);
    expect(generationUpdateCalls[0]?.data).toMatchObject({
      status: "completed",
      storage_url: "https://fal.media/late.mp3",
    });
  });

  test("still-pending under deadline leaves hold and row untouched", async () => {
    pendingRows = [makeGeneration({ id: "gen-still-pending" })];
    getJobStatusImpl = async () => ({ state: "pending" });

    const stats = await reconcilePendingMusicGenerations({ apiKeys: { FAL_KEY: "k" } });

    expect(stats).toMatchObject({ stillPending: 1, charged: 0, refunded: 0 });
    expect(reconcileCalls).toHaveLength(0);
    expect(generationUpdateCalls).toHaveLength(0);
  });
});
