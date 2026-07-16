/** In-memory bus: broadcasts to others, never echoes self, stops on disconnect. */
import { describe, expect, it } from "vitest";
import type { ShellSyncEnvelope } from "../protocol";
import { createInMemoryShellSyncBus } from "../transport";

const presence: ShellSyncEnvelope = {
  type: "presence",
  protocolVersion: "1",
  event: "announce",
  windowId: "a",
  priority: 0,
};

describe("createInMemoryShellSyncBus", () => {
  it("delivers to other endpoints but not the sender", () => {
    const bus = createInMemoryShellSyncBus();
    const a = bus.connect();
    const b = bus.connect();
    const aSeen: ShellSyncEnvelope[] = [];
    const bSeen: ShellSyncEnvelope[] = [];
    a.subscribe((e) => aSeen.push(e));
    b.subscribe((e) => bSeen.push(e));
    a.send(presence);
    expect(aSeen).toHaveLength(0);
    expect(bSeen).toHaveLength(1);
    expect(bSeen[0].type).toBe("presence");
  });

  it("delivers a structural copy, not the same reference", () => {
    const bus = createInMemoryShellSyncBus();
    const a = bus.connect();
    const b = bus.connect();
    let received: ShellSyncEnvelope | null = null;
    b.subscribe((e) => {
      received = e;
    });
    a.send(presence);
    expect(received).not.toBe(presence);
    expect(received).toEqual(presence);
  });

  it("a disconnected endpoint neither sends nor receives", () => {
    const bus = createInMemoryShellSyncBus();
    const a = bus.connect();
    const b = bus.connect();
    const bSeen: ShellSyncEnvelope[] = [];
    b.subscribe((e) => bSeen.push(e));
    bus.disconnect(a);
    a.send(presence);
    expect(bSeen).toHaveLength(0);
  });
});
