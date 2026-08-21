/**
 * Tests the bounded native-navigation replay boundary with real DOM events,
 * plus the single-owner claim contract (#23350): a listener only consumes a
 * request after reporting it actually APPLIED it, `dispatchNavigateViewRequest`
 * only resolves `true` on that same confirmation, and a dropped-for-overflow
 * request is observable rather than silently discarded.
 */
// @vitest-environment jsdom

import { logger } from "@elizaos/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchNavigateViewRequest,
  listenForNavigateViewRequests,
} from "./index";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("native navigate-view requests", () => {
  it("replays a pre-listener request exactly once", () => {
    dispatchNavigateViewRequest({ viewPath: "/apps/deploy" });
    const received: Array<string | null | undefined> = [];
    cleanups.push(
      listenForNavigateViewRequests((event) => {
        received.push(event.detail.viewPath);
      }),
    );

    expect(received).toEqual(["/apps/deploy"]);
  });

  it("delivers a post-listener request without a later stale replay", () => {
    const received: Array<string | null | undefined> = [];
    const firstCleanup = listenForNavigateViewRequests((event) => {
      received.push(event.detail.viewPath);
    });
    cleanups.push(firstCleanup);

    dispatchNavigateViewRequest({ viewPath: "/settings" });
    expect(received).toEqual(["/settings"]);

    firstCleanup();
    cleanups.pop();
    cleanups.push(
      listenForNavigateViewRequests((event) => {
        received.push(event.detail.viewPath);
      }),
    );
    expect(received).toEqual(["/settings"]);
  });

  it("replays multiple cold-boot intents in delivery order", () => {
    dispatchNavigateViewRequest({ viewPath: "/wallet" });
    dispatchNavigateViewRequest({ viewPath: "/connectors" });
    const received: Array<string | null | undefined> = [];
    cleanups.push(
      listenForNavigateViewRequests((event) => {
        received.push(event.detail.viewPath);
      }),
    );

    expect(received).toEqual(["/wallet", "/connectors"]);
  });

  it("does not resolve the dispatch promise until a listener actually applies the request (ack-gating contract)", async () => {
    let resolvedApplied: boolean | undefined;
    const applied = dispatchNavigateViewRequest({ viewPath: "/apps/deploy" });
    applied.then((value) => {
      resolvedApplied = value;
    });

    // Nothing has mounted yet — enqueuing alone must never resolve the
    // promise a caller (mobile-lifecycle) uses to gate a native ack.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvedApplied).toBeUndefined();

    cleanups.push(listenForNavigateViewRequests(() => {}));
    expect(await applied).toBe(true);
    expect(resolvedApplied).toBe(true);
  });

  it("leaves the dispatch promise pending (not falsely resolved) while a listener declines to apply", async () => {
    let settled: boolean | undefined;
    let firstCalls = 0;
    const applied = dispatchNavigateViewRequest({
      viewPath: "/wallet-decline",
    });
    void applied.then((value) => {
      settled = value;
    });

    cleanups.push(
      listenForNavigateViewRequests(() => {
        firstCalls += 1;
        return false;
      }),
    );
    expect(firstCalls).toBeGreaterThanOrEqual(1);

    // Declining is not the same as failing: the promise must stay pending
    // (never settle `false`) so a later-mounting listener still has a
    // legitimate chance to apply it — only an actual drop (overflow) or a
    // genuine claim settles it.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeUndefined();

    const secondReceived: Array<string | null | undefined> = [];
    cleanups.push(
      listenForNavigateViewRequests((event) => {
        secondReceived.push(event.detail.viewPath);
      }),
    );
    expect(secondReceived).toEqual(["/wallet-decline"]);
    expect(await applied).toBe(true);
  });

  it("multi-listener ownership race: a throwing first listener must not steal the intent from the second", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      let firstThrew = 0;
      cleanups.push(
        listenForNavigateViewRequests(() => {
          firstThrew += 1;
          throw new Error("boom: first listener explodes on mount");
        }),
      );
      const secondReceived: Array<string | null | undefined> = [];
      cleanups.push(
        listenForNavigateViewRequests((event) => {
          secondReceived.push(event.detail.viewPath);
        }),
      );

      const applied = dispatchNavigateViewRequest({
        viewPath: "/connectors-throw-race",
      });

      // Both listeners saw the dispatch (real DOM dispatchEvent semantics: one
      // listener throwing does not stop the next attached listener), but only
      // the second — the one that actually applied it — gets credit; the
      // throw is surfaced via a warning, never silently swallowed.
      expect(firstThrew).toBeGreaterThanOrEqual(1);
      expect(secondReceived).toEqual(["/connectors-throw-race"]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        expect.stringContaining("listener threw"),
      );
      return applied.then((value) => {
        expect(value).toBe(true);
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("multi-listener ownership race: a no-op/unmounted first listener does not permanently consume the intent", () => {
    const secondReceived: Array<string | null | undefined> = [];
    cleanups.push(
      // Mounts first, but declines to apply (e.g. it decided the intent isn't
      // its concern) — must not block the canonical listener behind it.
      listenForNavigateViewRequests(() => false),
    );
    cleanups.push(
      listenForNavigateViewRequests((event) => {
        secondReceived.push(event.detail.viewPath);
      }),
    );

    dispatchNavigateViewRequest({ viewPath: "/settings" });
    expect(secondReceived).toEqual(["/settings"]);
  });

  it("reentrant/concurrent dispatch preserves delivery order under a single canonical listener", () => {
    const received: Array<string | null | undefined> = [];
    const stop = listenForNavigateViewRequests((event) => {
      received.push(event.detail.viewPath);
      // Dispatch a second intent from inside the listener — a plausible
      // real-world reentrant case (a handler that itself triggers another
      // navigation) — and confirm it queues/delivers after the current one
      // rather than interleaving or being dropped.
      if (event.detail.viewPath === "/wallet") {
        dispatchNavigateViewRequest({ viewPath: "/connectors" });
      }
    });
    cleanups.push(stop);

    dispatchNavigateViewRequest({ viewPath: "/wallet" });
    expect(received).toEqual(["/wallet", "/connectors"]);
  });

  it("does not let a reentrant dispatch overtake an already-queued cold-boot intent", () => {
    dispatchNavigateViewRequest({ viewPath: "/wallet" });
    dispatchNavigateViewRequest({ viewPath: "/settings" });
    const received: Array<string | null | undefined> = [];
    cleanups.push(
      listenForNavigateViewRequests((event) => {
        received.push(event.detail.viewPath);
        if (event.detail.viewPath === "/wallet") {
          dispatchNavigateViewRequest({ viewPath: "/connectors" });
        }
      }),
    );

    expect(received).toEqual(["/wallet", "/settings", "/connectors"]);
  });

  it("overflow: dropping the oldest pending request past the bound is observable and resolves its promise false", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const applied: Array<Promise<boolean>> = [];
      // No listener mounted — every dispatch stays queued until the 16-item
      // bound forces the oldest out.
      for (let i = 0; i < 17; i += 1) {
        applied.push(
          dispatchNavigateViewRequest({ viewPath: `/overflow-${i}` }),
        );
      }

      expect(await applied[0]).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ viewPath: "/overflow-0" }),
        expect.stringContaining("dropped oldest pending request"),
      );

      // The surviving 16 requests (index 1..16) still replay in order to a
      // listener that mounts afterward.
      const received: Array<string | null | undefined> = [];
      cleanups.push(
        listenForNavigateViewRequests((event) => {
          received.push(event.detail.viewPath);
        }),
      );
      expect(received).toEqual(
        Array.from({ length: 16 }, (_, i) => `/overflow-${i + 1}`),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
