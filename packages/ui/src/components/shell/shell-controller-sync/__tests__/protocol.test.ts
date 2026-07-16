/**
 * Pure protocol helpers: owner election, peer pruning, snapshot ordering,
 * version gating, and the IPC-boundary envelope validator. All deterministic —
 * no transport, no clock.
 */
import { describe, expect, it } from "vitest";
import {
  electOwnerWindowId,
  isProtocolCompatible,
  isSnapshotNewer,
  parseShellSyncEnvelope,
  pruneStalePeers,
  SHELL_SYNC_PROTOCOL_VERSION,
  type ShellPeer,
} from "../protocol";

function peer(over: Partial<ShellPeer>): ShellPeer {
  return {
    windowId: "w",
    priority: 0,
    protocolVersion: SHELL_SYNC_PROTOCOL_VERSION,
    lastSeenMs: 0,
    ...over,
  };
}

describe("electOwnerWindowId", () => {
  it("returns null for an empty set", () => {
    expect(electOwnerWindowId([])).toBeNull();
  });
  it("prefers lower priority", () => {
    expect(
      electOwnerWindowId([
        peer({ windowId: "b", priority: 3 }),
        peer({ windowId: "a", priority: 0 }),
      ]),
    ).toBe("a");
  });
  it("breaks ties on window id", () => {
    expect(
      electOwnerWindowId([
        peer({ windowId: "z", priority: 1 }),
        peer({ windowId: "a", priority: 1 }),
      ]),
    ).toBe("a");
  });
});

describe("pruneStalePeers", () => {
  it("keeps peers within the ttl and drops older ones", () => {
    const kept = pruneStalePeers(
      [peer({ windowId: "fresh", lastSeenMs: 900 }), peer({ windowId: "old", lastSeenMs: 100 })],
      1000,
      200,
    );
    expect(kept.map((p) => p.windowId)).toEqual(["fresh"]);
  });
});

describe("isSnapshotNewer", () => {
  it("treats the first snapshot as newer", () => {
    expect(isSnapshotNewer({ epoch: 1, seq: 1 }, null)).toBe(true);
  });
  it("advances on higher seq within an epoch", () => {
    expect(isSnapshotNewer({ epoch: 1, seq: 2 }, { epoch: 1, seq: 1 })).toBe(true);
    expect(isSnapshotNewer({ epoch: 1, seq: 1 }, { epoch: 1, seq: 1 })).toBe(false);
    expect(isSnapshotNewer({ epoch: 1, seq: 1 }, { epoch: 1, seq: 2 })).toBe(false);
  });
  it("a higher epoch always wins; a lower epoch never does", () => {
    expect(isSnapshotNewer({ epoch: 2, seq: 1 }, { epoch: 1, seq: 99 })).toBe(true);
    expect(isSnapshotNewer({ epoch: 1, seq: 99 }, { epoch: 2, seq: 1 })).toBe(false);
  });
});

describe("isProtocolCompatible", () => {
  it("matches only the current version", () => {
    expect(isProtocolCompatible(SHELL_SYNC_PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolCompatible("999")).toBe(false);
  });
});

describe("parseShellSyncEnvelope", () => {
  it("rejects non-objects and unknown types", () => {
    expect(parseShellSyncEnvelope(null)).toBeNull();
    expect(parseShellSyncEnvelope("x")).toBeNull();
    expect(parseShellSyncEnvelope({ type: "nope", protocolVersion: "1" })).toBeNull();
    expect(parseShellSyncEnvelope({ type: "presence" })).toBeNull();
  });
  it("accepts a well-formed presence", () => {
    expect(
      parseShellSyncEnvelope({
        type: "presence",
        protocolVersion: "1",
        event: "announce",
        windowId: "w",
        priority: 0,
      }),
    ).not.toBeNull();
  });
  it("rejects a presence with a bad event / missing fields", () => {
    expect(
      parseShellSyncEnvelope({
        type: "presence",
        protocolVersion: "1",
        event: "nope",
        windowId: "w",
        priority: 0,
      }),
    ).toBeNull();
  });
  it("accepts a well-formed snapshot / command / ack", () => {
    expect(
      parseShellSyncEnvelope({
        type: "snapshot",
        protocolVersion: "1",
        ownerWindowId: "o",
        epoch: 1,
        seq: 1,
        snapshot: {},
      }),
    ).not.toBeNull();
    expect(
      parseShellSyncEnvelope({
        type: "command",
        protocolVersion: "1",
        commandId: "c",
        fromWindowId: "f",
        command: { kind: "open" },
      }),
    ).not.toBeNull();
    expect(
      parseShellSyncEnvelope({
        type: "ack",
        protocolVersion: "1",
        commandId: "c",
        toWindowId: "t",
        ok: true,
      }),
    ).not.toBeNull();
  });
  it("rejects a snapshot missing its payload", () => {
    expect(
      parseShellSyncEnvelope({
        type: "snapshot",
        protocolVersion: "1",
        ownerWindowId: "o",
        epoch: 1,
        seq: 1,
      }),
    ).toBeNull();
  });
});
