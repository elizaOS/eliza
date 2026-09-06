/**
 * Exercises Gmail's immutable memory-segment cache with real in-memory adapter
 * persistence, bounded late reads, authorization denial, corruption, restart,
 * atomic publication, and explicit retention cleanup.
 */
import { type IAgentRuntime, InMemoryDatabaseAdapter, type UUID } from "@elizaos/core/node";
import { describe, expect, it } from "vitest";
import {
  buildGmailContentPublication,
  cleanupExpiredGmailContent,
  GMAIL_CONTENT_SEGMENT_MAX_BYTES,
  gmailContentReference,
  loadGmailContentManifest,
  publishGmailContent,
  readGmailContentPage,
} from "./gmail-content-cache.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const OTHER_OWNER_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const OTHER_ROOM_ID = "00000000-0000-0000-0000-000000000005" as UUID;

function runtime(adapter = new InMemoryDatabaseAdapter()): IAgentRuntime {
  return { agentId: AGENT_ID, adapter } as unknown as IAgentRuntime;
}

function projection(value: string, rt = runtime(), now?: number) {
  return {
    runtime: rt,
    value: buildGmailContentPublication({
      runtime: rt,
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
      accountId: "account-a",
      messageId: "message-a",
      providerRevision: "history-a",
      text: value,
      now,
    }),
  };
}

async function publish(value: string, rt = runtime(), now?: number) {
  const built = projection(value, rt, now).value;
  expect(
    await publishGmailContent({ runtime: rt, projection: built, expectedRevision: null })
  ).toBe("published");
  const reference = gmailContentReference(built.head.id as UUID);
  const authorization = { ownerEntityId: OWNER_ID, roomId: ROOM_ID, accountId: "account-a" };
  const loaded = await loadGmailContentManifest({ runtime: rt, reference, authorization });
  return { rt, built, reference, authorization, loaded };
}

describe("Gmail segmented content cache", () => {
  it("preserves Unicode boundaries and reads 1 MiB and 10 MiB late canaries with bounded rows", async () => {
    for (const size of [1024 * 1024, 10 * 1024 * 1024]) {
      const canary = "😀LATE-CANARY";
      const source = `${"x".repeat(size)}${canary}`;
      const cached = await publish(source);
      expect(
        cached.built.manifest.segments.every(
          (segment) => segment.byteEnd - segment.byteStart <= GMAIL_CONTENT_SEGMENT_MAX_BYTES
        )
      ).toBe(true);
      const start = Buffer.byteLength("x".repeat(size));
      const page = await readGmailContentPage({
        runtime: cached.rt,
        loaded: cached.loaded,
        authorization: cached.authorization,
        unit: "byte",
        offset: start,
        limit: Buffer.byteLength(canary),
      });
      expect(page.text).toBe(canary);
      expect(page.sourceWork).toEqual({ headReads: 1, segmentRows: 1 });
    }
  });

  it("resolves repeat pages after an adapter-preserving process restart", async () => {
    const adapter = new InMemoryDatabaseAdapter();
    const firstRuntime = runtime(adapter);
    const cached = await publish("first\nsecond\nthird\n", firstRuntime);
    const first = await readGmailContentPage({
      runtime: firstRuntime,
      loaded: cached.loaded,
      authorization: cached.authorization,
      unit: "line",
      offset: 0,
      limit: 1,
    });
    expect(first.text).toBe("first\n");

    const restartedRuntime = runtime(adapter);
    const restarted = await loadGmailContentManifest({
      runtime: restartedRuntime,
      reference: cached.reference,
      authorization: cached.authorization,
    });
    const second = await readGmailContentPage({
      runtime: restartedRuntime,
      loaded: restarted,
      authorization: cached.authorization,
      unit: "line",
      offset: 1,
      limit: 1,
    });
    expect(second.text).toBe("second\n");
  });

  it.each([
    [{ ownerEntityId: OTHER_OWNER_ID, roomId: ROOM_ID, accountId: "account-a" }, "owner"],
    [{ ownerEntityId: OWNER_ID, roomId: OTHER_ROOM_ID, accountId: "account-a" }, "room"],
    [{ ownerEntityId: OWNER_ID, roomId: ROOM_ID, accountId: "account-b" }, "account"],
  ] as const)("denies a cross-%s continuation", async (authorization) => {
    const cached = await publish("private body");
    await expect(
      loadGmailContentManifest({
        runtime: cached.rt,
        reference: cached.reference,
        authorization,
      })
    ).rejects.toMatchObject({ code: "GMAIL_READ_FORBIDDEN" });
  });

  it("fails closed when a selected immutable segment is corrupt", async () => {
    const cached = await publish("safe body");
    const segmentId = cached.built.manifest.segments[0].id;
    await cached.rt.adapter.updateMemories([{ id: segmentId, content: { text: "evil body" } }]);
    await expect(
      readGmailContentPage({
        runtime: cached.rt,
        loaded: cached.loaded,
        authorization: cached.authorization,
        unit: "byte",
        offset: 0,
        limit: 4,
      })
    ).rejects.toMatchObject({ code: "GMAIL_READ_CACHE_CORRUPT" });
  });

  it("removes expired heads and their segments through explicit retention cleanup", async () => {
    const cached = await publish("expired", runtime(), 1);
    const result = await cleanupExpiredGmailContent({
      runtime: cached.rt,
      roomId: ROOM_ID,
      now: 1 + 8 * 24 * 60 * 60 * 1000,
    });
    expect(result).toEqual({ heads: 1, segments: 1 });
    await expect(
      loadGmailContentManifest({
        runtime: cached.rt,
        reference: cached.reference,
        authorization: cached.authorization,
      })
    ).rejects.toMatchObject({ code: "GMAIL_READ_REFERENCE_UNRESOLVED" });
  });
});
