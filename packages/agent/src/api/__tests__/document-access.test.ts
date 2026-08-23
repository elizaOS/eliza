/**
 * Unit coverage for the knowledge-document access wall — room surface
 * classification, scope parsing, facet filtering, read/mutate authorization,
 * and the public send/surface walls (#13593 / #13595 spill guards).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  ChannelType: {
    DM: "dm",
    SELF: "self",
    VOICE_DM: "voice_dm",
    API: "api",
    GROUP: "group",
    VOICE_GROUP: "voice_group",
    FEED: "feed",
    THREAD: "thread",
    WORLD: "world",
    FORUM: "forum",
    AUTONOMOUS: "autonomous",
  },
}));

import {
  roomIsPrivateSurface,
  roomIsPublicSurface,
  getDocumentVisibilityScope,
  parseDocumentScope,
  documentScopedEntityId,
  documentRoomId,
  documentTags,
  documentMediaFormat,
  matchesDocumentFilter,
  canReadDocumentMemory,
  canMutateDocumentMemory,
  canSendDocumentToPublic,
  canSurfaceDocumentInRoom,
} from "./document-access.ts";
import { ChannelType } from "@elizaos/core";

const OWNER = { entityId: "owner-1", role: "OWNER" as const };
const USER = { entityId: "user-1", role: "USER" as const };
const AGENT = { entityId: "agent-1", role: "AGENT" as const };
const RUNTIME = { entityId: "rt-1", role: "RUNTIME" as const };

describe("room surface classification", () => {
  it("classifies DM/SELF/VOICE_DM/API as private", () => {
    expect(roomIsPrivateSurface(ChannelType.DM)).toBe(true);
    expect(roomIsPrivateSurface(ChannelType.SELF)).toBe(true);
    expect(roomIsPrivateSurface(ChannelType.VOICE_DM)).toBe(true);
    expect(roomIsPrivateSurface(ChannelType.API)).toBe(true);
  });

  it("classifies group/feed/thread/world/forum as public (fails closed)", () => {
    for (const t of [ChannelType.GROUP, ChannelType.VOICE_GROUP, ChannelType.FEED,
                     ChannelType.THREAD, ChannelType.WORLD, ChannelType.FORUM,
                     ChannelType.AUTONOMOUS]) {
      expect(roomIsPrivateSurface(t)).toBe(false);
      expect(roomIsPublicSurface(t)).toBe(true);
    }
  });

  it("treats unknown types as public (fail closed)", () => {
    expect(roomIsPrivateSurface("future-channel")).toBe(false);
    expect(roomIsPrivateSurface(undefined)).toBe(false);
  });
});

describe("scope helpers", () => {
  it("parses valid scopes and rejects unknown", () => {
    expect(parseDocumentScope("global")).toBe("global");
    expect(parseDocumentScope("owner-private")).toBe("owner-private");
    expect(parseDocumentScope("nonsense")).toBeUndefined();
    expect(parseDocumentScope(undefined)).toBeUndefined();
  });

  it("defaults missing scope to global", () => {
    expect(getDocumentVisibilityScope(undefined)).toBe("global");
    expect(getDocumentVisibilityScope({})).toBe("global");
    expect(getDocumentVisibilityScope({ scope: "user-private" })).toBe("user-private");
  });

  it("resolves scoped entity from metadata scopedToEntityId, addedBy, then entityId", () => {
    expect(
      documentScopedEntityId({
        entityId: "mem-1",
        metadata: { scopedToEntityId: "scoped-1", addedBy: "adder-1" },
      }),
    ).toBe("scoped-1");
    expect(
      documentScopedEntityId({ entityId: "mem-1", metadata: { addedBy: "adder-1" } }),
    ).toBe("adder-1");
    expect(documentScopedEntityId({ entityId: "mem-1" })).toBe("mem-1");
  });

  it("extracts tags and media format (explicit over tag)", () => {
    expect(documentTags(undefined)).toEqual([]);
    expect(documentTags({ tags: ["a", 1, "b"] })).toEqual(["a", "b"]);
    expect(
      documentMediaFormat({ mediaFormat: "PDF" }, ["media-format:docx"]),
    ).toBe("pdf");
    expect(documentMediaFormat({}, ["media-format:docx"])).toBe("docx");
    expect(documentMediaFormat({}, [])).toBeUndefined();
  });
});

describe("matchesDocumentFilter", () => {
  const mem = {
    id: "m1",
    createdAt: 1000,
    content: { text: "quarterly report pdf" },
    metadata: {
      scope: "user-private",
      scopedToEntityId: "user-1",
      addedBy: "adder-1",
      roomId: "room-9",
      tags: ["finance", "media-format:pdf"],
      mediaFormat: "pdf",
      title: "Q3 Report",
    },
  };

  it("matches by scope", () => {
    expect(matchesDocumentFilter(mem, { scope: "user-private" })).toBe(true);
    expect(matchesDocumentFilter(mem, { scope: "global" })).toBe(false);
  });

  it("matches by scopedToEntityId, addedBy, roomId", () => {
    expect(matchesDocumentFilter(mem, { scopedToEntityId: "user-1" })).toBe(true);
    expect(matchesDocumentFilter(mem, { scopedToEntityId: "other" })).toBe(false);
    expect(matchesDocumentFilter(mem, { addedBy: "adder-1" })).toBe(true);
    expect(matchesDocumentFilter(mem, { roomId: "room-9" })).toBe(true);
    expect(matchesDocumentFilter(mem, { roomId: "room-x" })).toBe(false);
  });

  it("matches by tags (all required)", () => {
    expect(matchesDocumentFilter(mem, { tags: ["finance"] })).toBe(true);
    expect(matchesDocumentFilter(mem, { tags: ["finance", "media-format:pdf"] })).toBe(true);
    expect(matchesDocumentFilter(mem, { tags: ["finance", "missing"] })).toBe(false);
  });

  it("matches by mediaFormat", () => {
    expect(matchesDocumentFilter(mem, { mediaFormat: "pdf" })).toBe(true);
    expect(matchesDocumentFilter(mem, { mediaFormat: "docx" })).toBe(false);
  });

  it("matches by query against text and metadata fields", () => {
    expect(matchesDocumentFilter(mem, { query: "report" })).toBe(true);
    expect(matchesDocumentFilter(mem, { query: "Q3" })).toBe(true); // title
    expect(matchesDocumentFilter(mem, { query: "absent" })).toBe(false);
  });

  it("matches by time range using metadata.timestamp / addedAt / createdAt", () => {
    expect(matchesDocumentFilter(mem, { timeRangeStart: 500 })).toBe(true);
    expect(matchesDocumentFilter(mem, { timeRangeStart: 2000 })).toBe(false);
    expect(matchesDocumentFilter(mem, { timeRangeEnd: 1500 })).toBe(true);
    expect(matchesDocumentFilter(mem, { timeRangeEnd: 500 })).toBe(false);
  });
});

describe("canReadDocumentMemory (scope wall)", () => {
  const global = { metadata: { scope: "global" } };
  const ownerPriv = { metadata: { scope: "owner-private" } };
  const agentPriv = { metadata: { scope: "agent-private" } };
  const userPriv = { entityId: "m1", metadata: { scope: "user-private", scopedToEntityId: "user-1" } };

  it("global is readable by anyone", () => {
    expect(canReadDocumentMemory(global, USER)).toBe(true);
  });

  it("owner-private requires OWNER or RUNTIME", () => {
    expect(canReadDocumentMemory(ownerPriv, OWNER)).toBe(true);
    expect(canReadDocumentMemory(ownerPriv, RUNTIME)).toBe(true);
    expect(canReadDocumentMemory(ownerPriv, USER)).toBe(false);
    expect(canReadDocumentMemory(ownerPriv, AGENT)).toBe(false);
  });

  it("agent-private requires OWNER/AGENT/RUNTIME", () => {
    expect(canReadDocumentMemory(agentPriv, AGENT)).toBe(true);
    expect(canReadDocumentMemory(agentPriv, OWNER)).toBe(true);
    expect(canReadDocumentMemory(agentPriv, RUNTIME)).toBe(true);
    expect(canReadDocumentMemory(agentPriv, USER)).toBe(false);
  });

  it("user-private matches the scoped entity for USER", () => {
    expect(canReadDocumentMemory(userPriv, USER)).toBe(true);
    expect(canReadDocumentMemory(userPriv, { ...USER, entityId: "other" })).toBe(false);
  });

  it("AGENT/RUNTIME can read any user-private item", () => {
    expect(canReadDocumentMemory(userPriv, AGENT)).toBe(true);
    expect(canReadDocumentMemory(userPriv, RUNTIME)).toBe(true);
  });

  it("OWNER reads user-private via scopedToEntityId filter or own entityId", () => {
    expect(canReadDocumentMemory(userPriv, OWNER, { scopedToEntityId: "user-1" })).toBe(true);
    expect(canReadDocumentMemory({ ...userPriv, metadata: { ...userPriv.metadata, scopedToEntityId: "owner-1" } }, OWNER)).toBe(true);
  });

  it("user-private with no scoped entity is unreadable", () => {
    expect(canReadDocumentMemory({ metadata: { scope: "user-private" } }, USER)).toBe(false);
  });
});

describe("canMutateDocumentMemory", () => {
  it("global/owner-private require OWNER/RUNTIME", () => {
    expect(canMutateDocumentMemory({ metadata: { scope: "global" } } as never, OWNER)).toBe(true);
    expect(canMutateDocumentMemory({ metadata: { scope: "global" } } as never, USER)).toBe(false);
    expect(canMutateDocumentMemory({ metadata: { scope: "owner-private" } } as never, RUNTIME)).toBe(true);
  });

  it("agent-private requires OWNER/AGENT/RUNTIME", () => {
    expect(canMutateDocumentMemory({ metadata: { scope: "agent-private" } } as never, AGENT)).toBe(true);
    expect(canMutateDocumentMemory({ metadata: { scope: "agent-private" } } as never, USER)).toBe(false);
  });

  it("user-private allows scoped user or agent-class actors", () => {
    const mem = { metadata: { scope: "user-private", scopedToEntityId: "user-1" } } as never;
    expect(canMutateDocumentMemory(mem, USER)).toBe(true);
    expect(canMutateDocumentMemory(mem, AGENT)).toBe(true);
    expect(canMutateDocumentMemory(mem, { ...USER, entityId: "other" })).toBe(false);
  });
});

describe("send/surface walls", () => {
  const ownerPriv = { metadata: { scope: "owner-private" } };
  const userPriv = { metadata: { scope: "user-private" } };
  const global = { metadata: { scope: "global" } };

  it("canSendDocumentToPublic allows private→private and public-scope→public", () => {
    expect(canSendDocumentToPublic(ownerPriv, false)).toEqual({ ok: true });
    expect(canSendDocumentToPublic(global, true)).toEqual({ ok: true });
  });

  it("canSendDocumentToPublic blocks owner-private/user-private → public", () => {
    const r1 = canSendDocumentToPublic(ownerPriv, true);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.scope).toBe("owner-private");
    const r2 = canSendDocumentToPublic(userPriv, true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.scope).toBe("user-private");
  });

  it("canSurfaceDocumentInRoom blocks private items in public active rooms", () => {
    expect(canSurfaceDocumentInRoom(ownerPriv, true).ok).toBe(false);
    expect(canSurfaceDocumentInRoom(userPriv, true).ok).toBe(false);
    expect(canSurfaceDocumentInRoom(ownerPriv, false)).toEqual({ ok: true });
    expect(canSurfaceDocumentInRoom(global, true)).toEqual({ ok: true });
  });
});
