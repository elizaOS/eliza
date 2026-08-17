/**
 * Finalized-transcript commitment projection — unit tests (#14864). The
 * repository is mocked; the projection under test is the real production
 * function. Pins the two guards: only the owner's diarized segments are
 * read, and hedged speech never produces a ledger row.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import type { MeetingTranscriptFinalizedPayload } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertCommitmentLedgerRecord: vi.fn(async () => undefined),
}));

vi.mock("../src/lifeops/repository.js", () => ({
  LifeOpsRepository: class {
    upsertCommitmentLedgerRecord = mocks.upsertCommitmentLedgerRecord;
  },
}));

import {
  commitmentRecordsFromTranscript,
  projectFinalizedTranscriptCommitments,
} from "../src/lifeops/commitments/transcript-hook.js";

const CREATED_AT = Date.parse("2026-08-10T15:00:00.000Z");

function makePayload(withOwner = true): MeetingTranscriptFinalizedPayload {
  return {
    session: {
      id: "meeting-1",
      participants: [{ displayName: "Owner" }, { displayName: "Sam" }],
    },
    transcript: {
      id: "transcript-1",
      title: "Vendor sync",
      createdAt: CREATED_AT,
      segments: [
        {
          id: "seg-1",
          speakerEntityId: "owner-entity-1",
          startMs: 30_000,
          endMs: 34_000,
          text: "I'll send you the revised numbers by Friday.",
        },
        {
          id: "seg-2",
          speakerEntityId: "other-entity-9",
          startMs: 40_000,
          endMs: 44_000,
          text: "I'll get you the contract tomorrow.",
        },
        {
          id: "seg-3",
          speakerEntityId: "owner-entity-1",
          startMs: 50_000,
          endMs: 54_000,
          text: "Maybe we could revisit pricing sometime.",
        },
      ],
    },
    ...(withOwner
      ? {
          ghostAttendance: {
            ownerUserId: "owner-entity-1",
            ownerDisplayName: "Owner",
            careAbouts: [],
          },
        }
      : {}),
  } as unknown as MeetingTranscriptFinalizedPayload;
}

describe("transcript commitment projection", () => {
  beforeEach(() => {
    mocks.upsertCommitmentLedgerRecord.mockClear();
  });

  it("projects only the owner's firm promises with meeting-anchored timestamps", () => {
    const records = commitmentRecordsFromTranscript({
      agentId: "agent-transcript-test",
      ownerEntityId: "owner-entity-1",
      payload: makePayload(),
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "transcript",
      sourceKey: "transcript-1:seg-1",
      kind: "commitment",
    });
    expect(records[0]?.metadata).toMatchObject({
      transcriptId: "transcript-1",
      meetingId: "meeting-1",
      observedAt: new Date(CREATED_AT + 30_000).toISOString(),
    });
  });

  it("persists projected rows through the ledger repository", async () => {
    const runtime = {
      agentId: "agent-transcript-test" as UUID,
      adapter: { db: {} },
    } as unknown as IAgentRuntime;
    const count = await projectFinalizedTranscriptCommitments(
      runtime,
      makePayload(),
    );
    expect(count).toBe(1);
    expect(mocks.upsertCommitmentLedgerRecord).toHaveBeenCalledTimes(1);
  });

  it("returns typed-empty when the payload carries no owner identity", async () => {
    const runtime = {
      agentId: "agent-transcript-test" as UUID,
      adapter: { db: {} },
    } as unknown as IAgentRuntime;
    const count = await projectFinalizedTranscriptCommitments(
      runtime,
      makePayload(false),
    );
    expect(count).toBe(0);
    expect(mocks.upsertCommitmentLedgerRecord).not.toHaveBeenCalled();
  });

  it("returns typed-empty on hosts without a SQL ledger", async () => {
    const runtime = {
      agentId: "agent-transcript-test" as UUID,
    } as unknown as IAgentRuntime;
    const count = await projectFinalizedTranscriptCommitments(
      runtime,
      makePayload(),
    );
    expect(count).toBe(0);
  });
});
