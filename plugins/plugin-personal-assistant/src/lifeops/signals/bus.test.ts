import { describe, expect, it, vi } from "vitest";
import {
  createActivitySignalBus,
  getActivitySignalBus,
  registerActivitySignalBus,
} from "./bus";

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

describe("createActivitySignalBus", () => {
  it("publishes an event and returns it from recent()", () => {
    const bus = createActivitySignalBus();
    const event = { family: "message_activity_event", occurredAt: iso(now) };
    bus.publish(event);
    expect(bus.recent({ sinceIso: iso(now - 1_000) })).toEqual([event]);
  });

  it("throws when the envelope has no family", () => {
    const bus = createActivitySignalBus();
    expect(() => bus.publish({ occurredAt: iso(now) } as never)).toThrow(
      /family required/,
    );
  });

  it("throws when the envelope has no occurredAt", () => {
    const bus = createActivitySignalBus();
    expect(() =>
      bus.publish({ family: "message_activity_event" } as never),
    ).toThrow(/occurredAt required/);
  });

  it("rejects families not registered in the FamilyRegistry", () => {
    const bus = createActivitySignalBus({
      familyRegistry: {
        has: (family: string) => family === "message_activity_event",
      },
    });
    expect(() =>
      bus.publish({ family: "unknown_family", occurredAt: iso(now) } as never),
    ).toThrow(/not registered/);
  });

  it("accepts families registered in the FamilyRegistry", () => {
    const bus = createActivitySignalBus({
      familyRegistry: {
        has: (family: string) => family === "message_activity_event",
      },
    });
    expect(() =>
      bus.publish({ family: "message_activity_event", occurredAt: iso(now) }),
    ).not.toThrow();
  });

  it("filters recent() by sinceIso", () => {
    const bus = createActivitySignalBus();
    bus.publish({
      family: "message_activity_event",
      occurredAt: iso(now - 5_000),
    });
    bus.publish({ family: "message_activity_event", occurredAt: iso(now) });
    expect(bus.recent({ sinceIso: iso(now - 1_000) })).toHaveLength(1);
  });

  it("filters recent() by family", () => {
    const bus = createActivitySignalBus();
    bus.publish({ family: "message_activity_event", occurredAt: iso(now) });
    bus.publish({ family: "health_metric", occurredAt: iso(now) });
    const events = bus.recent({
      sinceIso: iso(now - 1_000),
      family: "health_metric",
    });
    expect(events).toHaveLength(1);
    expect(events[0].family).toBe("health_metric");
  });

  it("filters recent() by subject kind and id", () => {
    const bus = createActivitySignalBus();
    bus.publish({
      family: "message_activity_event",
      occurredAt: iso(now),
      subject: { kind: "task", id: "a" },
    });
    bus.publish({
      family: "message_activity_event",
      occurredAt: iso(now),
      subject: { kind: "task", id: "b" },
    });
    const events = bus.recent({
      sinceIso: iso(now - 1_000),
      family: "message_activity_event",
      subject: { kind: "task", id: "a" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].subject?.id).toBe("a");
  });

  it("sorts recent() ascending by occurredAt", () => {
    const bus = createActivitySignalBus();
    bus.publish({ family: "message_activity_event", occurredAt: iso(now) });
    bus.publish({
      family: "message_activity_event",
      occurredAt: iso(now - 1_000),
    });
    const events = bus.recent({ sinceIso: iso(now - 5_000) });
    expect(events.map((e) => e.occurredAt)).toEqual([
      iso(now - 1_000),
      iso(now),
    ]);
  });

  it("evicts events older than the retention window on publish", () => {
    const bus = createActivitySignalBus({ retentionMs: 1_000 });
    bus.publish({
      family: "message_activity_event",
      occurredAt: iso(now - 5_000),
    });
    bus.publish({ family: "message_activity_event", occurredAt: iso(now) });
    expect(bus.recent({ sinceIso: iso(now - 60_000) })).toHaveLength(1);
  });

  it("caps buffered events per family, dropping the oldest", () => {
    const bus = createActivitySignalBus({ maxEventsPerFamily: 2 });
    bus.publish({
      family: "message_activity_event",
      occurredAt: iso(now - 200),
    });
    bus.publish({
      family: "message_activity_event",
      occurredAt: iso(now - 100),
    });
    bus.publish({ family: "message_activity_event", occurredAt: iso(now) });
    const events = bus.recent({ sinceIso: iso(now - 60_000) });
    expect(events).toHaveLength(2);
    expect(events[0].occurredAt).toBe(iso(now - 100));
  });

  it("fans out synchronously to subscribers on publish", () => {
    const bus = createActivitySignalBus();
    const handler = vi.fn();
    bus.subscribe("message_activity_event", handler);
    const event = { family: "message_activity_event", occurredAt: iso(now) };
    bus.publish(event);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("does not notify subscribers of other families", () => {
    const bus = createActivitySignalBus();
    const handler = vi.fn();
    bus.subscribe("health_metric", handler);
    bus.publish({ family: "message_activity_event", occurredAt: iso(now) });
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const bus = createActivitySignalBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe("message_activity_event", handler);
    unsubscribe();
    bus.publish({ family: "message_activity_event", occurredAt: iso(now) });
    expect(handler).not.toHaveBeenCalled();
  });

  it("hasSignalSince reflects events of the given family since the instant", () => {
    const bus = createActivitySignalBus();
    expect(
      bus.hasSignalSince({
        signalKind: "message_activity_event",
        sinceIso: iso(now - 1_000),
      }),
    ).toBe(false);
    bus.publish({ family: "message_activity_event", occurredAt: iso(now) });
    expect(
      bus.hasSignalSince({
        signalKind: "message_activity_event",
        sinceIso: iso(now - 1_000),
      }),
    ).toBe(true);
  });

  it("throws when recent() receives a non-ISO sinceIso", () => {
    const bus = createActivitySignalBus();
    expect(() => bus.recent({ sinceIso: "not-a-date" })).toThrow(/ISO/);
  });

  it("registers and retrieves a per-runtime bus via WeakMap", () => {
    const bus = createActivitySignalBus();
    const runtime = {};
    registerActivitySignalBus(runtime as never, bus);
    expect(getActivitySignalBus(runtime as never)).toBe(bus);
    expect(getActivitySignalBus({} as never)).toBeNull();
  });
});
