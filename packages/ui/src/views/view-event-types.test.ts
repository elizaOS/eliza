/**
 * Covers the VIEW_EVENTS registry: every declared event name must be a
 * distinct, non-empty wire string, and publishing through the real view event
 * bus must route each constant to exactly its own subscriber (payload,
 * source, ordering, and unsubscribe behaviour included).
 *
 * Harness: real pub-sub over the jsdom window transport — no mocks.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  emitViewEvent,
  onAnyViewEvent,
  onViewEvent,
  type ViewEvent,
} from "./view-event-bus";
import { VIEW_EVENTS } from "./view-event-types";

const EVENT_NAMES = Object.values(VIEW_EVENTS);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const off of cleanups.splice(0)) off();
});

describe("VIEW_EVENTS registry", () => {
  it("declares at least one event", () => {
    expect(EVENT_NAMES.length).toBeGreaterThan(0);
  });

  it("maps every key to a non-empty string name", () => {
    for (const [key, name] of Object.entries(VIEW_EVENTS)) {
      expect(typeof name, `${key} must map to a string`).toBe("string");
      expect(name.length, `${key} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("never reuses one event name for two keys", () => {
    const seen = new Map<string, string>();
    for (const [key, name] of Object.entries(VIEW_EVENTS)) {
      const owner = seen.get(name);
      expect(
        owner,
        `${key} reuses the event name "${name}" already owned by ${owner ?? "?"}`,
      ).toBeUndefined();
      seen.set(name, key);
    }
  });
});

describe("VIEW_EVENTS routed through the view event bus", () => {
  it.each(Object.entries(VIEW_EVENTS))(
    "%s delivers its published payload to its own subscriber",
    (key, name) => {
      const received: ViewEvent[] = [];
      cleanups.push(
        onViewEvent(name, (event) => {
          received.push(event);
        }),
      );

      const payload = { [key]: true, seq: 1 };
      emitViewEvent(name, payload, "agent");

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.type).toBe(name);
      expect(event.payload).toEqual(payload);
      expect(event.sourceViewId).toBe("agent");
      expect(typeof event.timestamp).toBe("number");
      expect(event.timestamp).toBeGreaterThan(0);
    },
  );

  it("does not deliver one event name to subscribers of a different name", () => {
    const focused: string[] = [];
    const blurred: string[] = [];
    cleanups.push(
      onViewEvent(VIEW_EVENTS.VIEW_FOCUSED, (event) => {
        focused.push(event.type);
      }),
    );
    cleanups.push(
      onViewEvent(VIEW_EVENTS.VIEW_BLURRED, (event) => {
        blurred.push(event.type);
      }),
    );

    emitViewEvent(VIEW_EVENTS.AGENT_NAVIGATE, {});
    expect(focused).toHaveLength(0);
    expect(blurred).toHaveLength(0);

    emitViewEvent(VIEW_EVENTS.VIEW_FOCUSED, {});
    expect(focused).toEqual([VIEW_EVENTS.VIEW_FOCUSED]);
    expect(blurred).toHaveLength(0);
  });

  it("shows an any-event observer every declared kind exactly once, in emission order", () => {
    const observed: string[] = [];
    cleanups.push(
      onAnyViewEvent((event) => {
        observed.push(event.type);
      }),
    );

    for (const name of EVENT_NAMES) emitViewEvent(name, {});

    expect(observed).toEqual(EVENT_NAMES);
  });

  it("stops delivering to a subscriber after it unsubscribes", () => {
    const seen: string[] = [];
    const off = onViewEvent(VIEW_EVENTS.SETTINGS_CHANGED, (event) => {
      seen.push(event.type);
    });
    off();

    emitViewEvent(VIEW_EVENTS.SETTINGS_CHANGED, {});
    expect(seen).toHaveLength(0);
  });
});
