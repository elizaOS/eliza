/**
 * Tests InMemorySink record, snapshot isolation, ordering, and clear behaviour.
 */

import { describe, expect, it } from "vitest";
import type { AuditSink } from "./sink.js";
import { InMemorySink } from "./testing.js";
import type { AuditEvent } from "./types.js";

function makeEvent(eventId: string, action: AuditEvent["action"]): AuditEvent {
  return {
    event_id: eventId,
    ts: "2026-08-23T00:00:00.000Z",
    actor: { type: "user", id: "u_1" },
    action,
    result: "success",
    resource: null,
  };
}

describe("InMemorySink", () => {
  it("names itself memory and leaves required unspecified", () => {
    const sink = new InMemorySink();
    expect(sink.name).toBe("memory");
    const asSink: AuditSink = sink;
    expect(asSink.required).toBeUndefined();
  });

  it("snapshots an empty queue as an empty array", () => {
    const sink = new InMemorySink();
    expect(sink.snapshot()).toEqual([]);
  });

  it("records a single emitted event", async () => {
    const sink = new InMemorySink();
    const event = makeEvent(
      "11111111-1111-7111-8111-111111111111",
      "auth.login",
    );
    await sink.emit(event);
    expect(sink.snapshot()).toEqual([event]);
    expect(sink.snapshot()[0]).toBe(event);
  });

  it("preserves insertion order across multiple emits", async () => {
    const sink = new InMemorySink();
    const first = makeEvent(
      "11111111-1111-7111-8111-111111111111",
      "auth.login",
    );
    const second = makeEvent(
      "22222222-2222-7222-8222-222222222222",
      "auth.logout",
    );
    const third = makeEvent(
      "33333333-3333-7333-8333-333333333333",
      "api_key.use",
    );
    await sink.emit(first);
    await sink.emit(second);
    await sink.emit(third);
    expect(sink.snapshot()).toEqual([first, second, third]);
  });

  it("keeps duplicate events instead of collapsing ties", async () => {
    const sink = new InMemorySink();
    const event = makeEvent(
      "11111111-1111-7111-8111-111111111111",
      "auth.login",
    );
    await sink.emit(event);
    await sink.emit(event);
    const snap = sink.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]).toBe(event);
    expect(snap[1]).toBe(event);
  });

  it("returns a copied array so callers cannot mutate the queue", async () => {
    const sink = new InMemorySink();
    const event = makeEvent(
      "11111111-1111-7111-8111-111111111111",
      "auth.login",
    );
    await sink.emit(event);
    const first = sink.snapshot();
    first.pop();
    first.push(
      makeEvent("44444444-4444-7444-8444-444444444444", "auth.logout"),
    );
    expect(sink.snapshot()).toEqual([event]);
    expect(first).not.toBe(sink.snapshot());
  });

  it("clears recorded events and is a no-op on an empty queue", async () => {
    const sink = new InMemorySink();
    sink.clear();
    expect(sink.snapshot()).toEqual([]);

    await sink.emit(
      makeEvent("11111111-1111-7111-8111-111111111111", "auth.login"),
    );
    sink.clear();
    expect(sink.snapshot()).toEqual([]);

    const after = makeEvent(
      "55555555-5555-7555-8555-555555555555",
      "auth.logout",
    );
    await sink.emit(after);
    expect(sink.snapshot()).toEqual([after]);
  });

  it("isolates state across independent sink instances", async () => {
    const left = new InMemorySink();
    const right = new InMemorySink();
    const leftEvent = makeEvent(
      "11111111-1111-7111-8111-111111111111",
      "auth.login",
    );
    const rightEvent = makeEvent(
      "22222222-2222-7222-8222-222222222222",
      "auth.logout",
    );
    await left.emit(leftEvent);
    await right.emit(rightEvent);
    expect(left.snapshot()).toEqual([leftEvent]);
    expect(right.snapshot()).toEqual([rightEvent]);
  });

  it("has no capacity cap: every emit is retained", async () => {
    const sink = new InMemorySink();
    const events = Array.from({ length: 8 }, (_, i) =>
      makeEvent(
        `aaaaaaaa-aaaa-7aaa-8aaa-${String(i).padStart(12, "0")}`,
        "auth.login",
      ),
    );
    for (const event of events) {
      await sink.emit(event);
    }
    expect(sink.snapshot()).toEqual(events);
  });

  it("records an emit before the returned promise settles", () => {
    const sink = new InMemorySink();
    const event = makeEvent(
      "11111111-1111-7111-8111-111111111111",
      "auth.login",
    );
    const pending = sink.emit(event);
    expect(sink.snapshot()).toEqual([event]);
    return expect(pending).resolves.toBeUndefined();
  });
});
