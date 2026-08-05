/**
 * Deterministic coverage for pendant transcript delivery into conversation
 * Memory using a real in-memory pendant repository and core Memory records.
 */

import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryPendantSessionRepository } from "../../services/pendant-session/repository.ts";
import {
  stampCanonicalPendantMemory,
  verifyCanonicalPendantProvenance,
} from "../conversation-routes.ts";

const OWNER_ID = stringToUuid("pendant-owner");
const AGENT_ID = stringToUuid("pendant-agent");
const ROOM_ID = stringToUuid("pendant-conversation-room");
const SESSION_ID = "pendant-session-1";
const SEGMENT_ID = `${SESSION_ID}:segment:0`;

async function repositoryWithResolvedSegment(): Promise<InMemoryPendantSessionRepository> {
  const repository = new InMemoryPendantSessionRepository();
  await repository.create({
    schemaVersion: 1,
    session: {
      id: SESSION_ID,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      startedAt: "2026-08-05T00:00:00.000Z",
      endedAt: null,
      state: "active",
      captureLease: null,
      processingLocation: "cloud",
      revision: 1,
    },
    segments: [
      {
        id: SEGMENT_ID,
        sessionId: SESSION_ID,
        ordinal: 0,
        status: "resolved",
        text: "canonical pendant words",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        createdAt: "2026-08-05T00:00:01.000Z",
        updatedAt: "2026-08-05T00:00:02.000Z",
        startedAt: "2026-08-05T00:00:00.000Z",
        endedAt: "2026-08-05T00:00:02.000Z",
        revision: 1,
      },
    ],
    insightRefs: [],
  });
  return repository;
}

function metadata(): Record<string, unknown> {
  return {
    voiceSource: "pendant",
    pendantOwnerId: OWNER_ID,
    pendantAgentId: AGENT_ID,
    pendantSessionId: SESSION_ID,
    pendantSegmentId: SEGMENT_ID,
    pendantSegmentRevision: 1,
  };
}

describe("canonical pendant conversation provenance", () => {
  it("verifies the durable resolved segment and stamps one owner-private chat Memory shape", async () => {
    const repository = await repositoryWithResolvedSegment();
    const runtime = { agentId: AGENT_ID } as AgentRuntime;
    const provenance = await verifyCanonicalPendantProvenance(
      runtime,
      { entityId: OWNER_ID, role: "OWNER" },
      "canonical pendant words",
      metadata(),
      repository,
    );
    expect(provenance).not.toBeNull();

    const memory = createMessageMemory({
      id: stringToUuid(`conversation-user:${ROOM_ID}:pendant:${SEGMENT_ID}`),
      entityId: OWNER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: {
        text: "canonical pendant words",
        source: "pendant",
        channelType: ChannelType.VOICE_DM,
      },
    });
    const messages = { userMessage: memory, messageToStore: memory };
    if (!provenance) throw new Error("provenance was not resolved");
    stampCanonicalPendantMemory(messages, provenance);

    expect(memory.metadata).toMatchObject({
      type: "message",
      provider: "pendant",
      scope: "owner-private",
      scopedToEntityId: OWNER_ID,
      platformMessageId: SEGMENT_ID,
      base: {
        type: "message",
        source: "pendant",
        scope: "owner-private",
      },
      pendant: {
        userId: OWNER_ID,
        accountId: AGENT_ID,
        sessionId: SESSION_ID,
        segmentId: SEGMENT_ID,
        segmentRevision: 1,
      },
    });
  });

  it("rejects a forged caller or transcript that does not match the segment", async () => {
    const repository = await repositoryWithResolvedSegment();
    const runtime = { agentId: AGENT_ID } as AgentRuntime;

    await expect(
      verifyCanonicalPendantProvenance(
        runtime,
        { entityId: OWNER_ID, role: "USER" },
        "canonical pendant words",
        metadata(),
        repository,
      ),
    ).rejects.toMatchObject({ code: "PENDANT_TRANSCRIPT_OWNER_REQUIRED" });
    await expect(
      verifyCanonicalPendantProvenance(
        runtime,
        { entityId: OWNER_ID, role: "OWNER" },
        "forged words",
        metadata(),
        repository,
      ),
    ).rejects.toMatchObject({ code: "PENDANT_TRANSCRIPT_SEGMENT_MISMATCH" });
  });
});
