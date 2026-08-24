/**
 * Verifies useViewEvent / useEmitViewEvent — subscription lifecycle over the
 * real window-CustomEvent view-event bus (jsdom, synchronous delivery).
 * Covers the contracts mounted views depend on: teardown on unmount,
 * re-subscription on type/deps change without stale-handler leakage,
 * latest-inline-handler swap with single delivery, and the stable emit
 * reference shared across renders.
 */
// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewEvent } from "../views/view-event-bus";
import * as viewEventBus from "../views/view-event-bus";
import { useEmitViewEvent, useViewEvent } from "./useViewEvent";

const { emitViewEvent } = viewEventBus;

let typeSeq = 0;

afterEach(() => {
  cleanup();
});

describe("useViewEvent", () => {
  it("delivers an emitted event with payload, source, and timestamp to the live subscriber", () => {
    const type = `test:view-event:${++typeSeq}`;
    const received: ViewEvent[] = [];
    renderHook(() => useViewEvent(type, (event) => received.push(event)));

    emitViewEvent(type, { count: 3 }, "view-a");

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe(type);
    expect(received[0].payload).toEqual({ count: 3 });
    expect(received[0].sourceViewId).toBe("view-a");
    expect(typeof received[0].timestamp).toBe("number");
  });

  it("ignores events emitted under other types", () => {
    const type = `test:view-event:${++typeSeq}`;
    const other = `${type}:other`;
    const received: ViewEvent[] = [];
    renderHook(() => useViewEvent(type, (event) => received.push(event)));

    emitViewEvent(other, { step: 1 });
    emitViewEvent(type, { step: 2 });

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ step: 2 });
  });

  it("stops delivering after unmount", () => {
    const type = `test:view-event:${++typeSeq}`;
    const received: ViewEvent[] = [];
    const { unmount } = renderHook(() =>
      useViewEvent(type, (event) => received.push(event)),
    );

    emitViewEvent(type, { phase: "mounted" });
    expect(received).toHaveLength(1);

    unmount();
    emitViewEvent(type, { phase: "unmounted" });

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ phase: "mounted" });
  });

  it("re-subscribes when the type changes and no longer receives the previous type", () => {
    const firstType = `test:view-event:${++typeSeq}`;
    const secondType = `test:view-event:${++typeSeq}`;
    const received: ViewEvent[] = [];
    const { rerender } = renderHook(
      ({ type }: { type: string }) =>
        useViewEvent(type, (event) => received.push(event)),
      { initialProps: { type: firstType } },
    );

    rerender({ type: secondType });

    emitViewEvent(firstType, { generation: 1 });
    emitViewEvent(secondType, { generation: 2 });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe(secondType);
    expect(received[0].payload).toEqual({ generation: 2 });
  });

  it("routes deliveries to the latest inline handler without duplicating them", () => {
    const type = `test:view-event:${++typeSeq}`;
    const calls: string[] = [];
    let generation = 1;
    const { rerender } = renderHook(() =>
      useViewEvent(type, (event) =>
        calls.push(`gen${generation}:${String(event.payload.step)}`),
      ),
    );

    generation = 2;
    rerender();

    emitViewEvent(type, { step: "emit" });

    expect(calls).toEqual(["gen2:emit"]);
  });

  it("re-subscribes through the real bus when extra deps change", () => {
    const type = `test:view-event:${++typeSeq}`;
    const busSpy = vi.spyOn(viewEventBus, "onViewEvent");
    const received: viewEventBus.ViewEvent[] = [];
    const { rerender } = renderHook(
      ({ gate }: { gate: number }) =>
        useViewEvent(type, (event) => received.push(event), [gate]),
      { initialProps: { gate: 0 } },
    );
    expect(busSpy).toHaveBeenCalledTimes(1);
    expect(busSpy.mock.calls[0]?.[0]).toBe(type);

    rerender({ gate: 1 });
    expect(busSpy).toHaveBeenCalledTimes(2);

    emitViewEvent(type, { after: "resubscribe" });

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ after: "resubscribe" });
  });

  it("delivers one emission to every independent subscriber of the same type", () => {
    const type = `test:view-event:${++typeSeq}`;
    const first: ViewEvent[] = [];
    const second: ViewEvent[] = [];
    renderHook(() => useViewEvent(type, (event) => first.push(event)));
    renderHook(() => useViewEvent(type, (event) => second.push(event)));

    emitViewEvent(type, { broadcast: true });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toEqual(second[0]);
  });
});

describe("useEmitViewEvent", () => {
  it("returns a referentially stable emit function across rerenders", () => {
    const { result, rerender } = renderHook(() => useEmitViewEvent());
    const first = result.current;

    rerender();
    rerender();

    expect(result.current).toBe(first);
  });

  it("publishes through the real bus to a useViewEvent subscriber", () => {
    const type = `test:view-event:${++typeSeq}`;
    const received: ViewEvent[] = [];
    renderHook(() => useViewEvent(type, (event) => received.push(event)));
    const { result } = renderHook(() => useEmitViewEvent());

    result.current(type, { ok: true }, "view-emitter");

    expect(received).toHaveLength(1);
    expect(received[0].sourceViewId).toBe("view-emitter");
    expect(received[0].payload).toEqual({ ok: true });
  });

  it("defaults the payload to an empty object when emitted without one", () => {
    const type = `test:view-event:${++typeSeq}`;
    const received: ViewEvent[] = [];
    renderHook(() => useViewEvent(type, (event) => received.push(event)));
    const { result } = renderHook(() => useEmitViewEvent());

    result.current(type);

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({});
    expect(received[0].sourceViewId).toBeUndefined();
  });
});
