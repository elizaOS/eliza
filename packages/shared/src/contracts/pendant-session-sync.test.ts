/**
 * Contract tests for the pendant session sync wire format.
 *
 * These assertions keep browser clients and server routes aligned on stable
 * segment ids, strict validation, and typed error codes.
 */

import { describe, expect, it } from "vitest";
import {
  CreatePendantSessionRequestSchema,
  PendantSessionErrorResponseSchema,
  PendantSessionSnapshotSchema,
  pendantSegmentId,
  UpsertPendantSegmentRequestSchema,
} from "./pendant-session-sync";

describe("pendant session sync contract", () => {
  it("builds stable segment ids from session id and ordinal", () => {
    expect(pendantSegmentId("sess-a", 7)).toBe("sess-a:segment:7");
    expect(pendantSegmentId("sess-a", 7)).toBe(pendantSegmentId("sess-a", 7));
  });

  it("defaults processing location without accepting unknown fields", () => {
    expect(CreatePendantSessionRequestSchema.parse({})).toEqual({
      processingLocation: "on-device",
    });
    expect(() =>
      CreatePendantSessionRequestSchema.parse({ ownerId: "client" }),
    ).toThrow();
  });

  it("rejects client-spoofed segment identity and server timestamps", () => {
    expect(() =>
      UpsertPendantSegmentRequestSchema.parse({
        leaseToken: "lease",
        segment: {
          id: "sess-a:segment:0",
          sessionId: "sess-a",
          ordinal: 0,
          status: "resolved",
          text: "hello",
          words: [],
          speakerCluster: null,
          speakerAlias: null,
          confidence: null,
          error: null,
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:00.000Z",
          startedAt: "2026-07-09T00:00:00.000Z",
          endedAt: null,
          revision: 0,
        },
      }),
    ).toThrow();
  });

  it("requires insight refs to point at segment ids only", () => {
    const snapshot = PendantSessionSnapshotSchema.parse({
      schemaVersion: 1,
      session: {
        id: "sess-a",
        ownerId: "owner-a",
        agentId: "agent-a",
        startedAt: "2026-07-09T00:00:00.000Z",
        endedAt: null,
        state: "active",
        captureLease: null,
        processingLocation: "on-device",
        revision: 0,
      },
      segments: [],
      insightRefs: [
        {
          id: "insight-a",
          segmentIds: ["sess-a:segment:0"],
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:00.000Z",
          revision: 0,
        },
      ],
    });

    expect(snapshot.insightRefs[0]?.segmentIds).toEqual(["sess-a:segment:0"]);
  });

  it("keeps route errors typed", () => {
    expect(
      PendantSessionErrorResponseSchema.parse({
        ok: false,
        error: {
          code: "lease_conflict",
          message: "held",
          currentRevision: 3,
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "lease_conflict",
        message: "held",
        currentRevision: 3,
      },
    });
  });
});
