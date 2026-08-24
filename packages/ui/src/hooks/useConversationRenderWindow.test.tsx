/** Verifies useConversationRenderWindow (#15281) through the package's configured test harness. */
// @vitest-environment jsdom
//
// Unit coverage for the bounded render-window engine (#15281): reveal-before-
// fetch window growth, the MAX_LOADED_SHELL_WINDOW cap latch, the hasMore latch,
// the fetch error path (rejection propagates, no fabricated state), the
// conversation-switch reset + mid-flight stale-result drop, and the search-jump
// revealFullWindow. Pure hook driven with renderHook — no DOM, no vi.mock of the
// hook under test; renderableCount + conversationKey are props so a prepend /
// switch is simulated by re-rendering, mirroring the real caller's state flow.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LoadOlderResult } from "../state/load-older-conversation-messages";
import { useConversationRenderWindow } from "./useConversationRenderWindow";

const INITIAL_WINDOW = 80;
const STEP = 50;
const CAP = 400;

/** A fetchOlder that never resolves until `resolve` is called — for race tests. */
function deferredFetch() {
  let resolve!: (value: LoadOlderResult) => void;
  const fetchOlder = vi.fn(
    () =>
      new Promise<LoadOlderResult>((r) => {
        resolve = r;
      }),
  );
  return { fetchOlder, resolve: (v: LoadOlderResult) => resolve(v) };
}

describe("useConversationRenderWindow (#15281)", () => {
  it("opens at MAX_RENDERED_SHELL_MESSAGES regardless of the loaded count", () => {
    const { result } = renderHook(() =>
      useConversationRenderWindow({
        renderableCount: 500,
        conversationKey: "c",
        fetchOlder: async () => ({ hasMore: true, prependedCount: 0 }),
      }),
    );
    expect(result.current.windowSize).toBe(INITIAL_WINDOW);
    expect(result.current.canLoadOlder).toBe(true);
  });

  it("reveals already-loaded turns a page at a time before ever fetching", async () => {
    const fetchOlder = vi.fn(
      async (): Promise<LoadOlderResult> => ({
        hasMore: true,
        prependedCount: 0,
      }),
    );
    const { result } = renderHook(() =>
      useConversationRenderWindow({
        renderableCount: 200,
        conversationKey: "c",
        fetchOlder,
      }),
    );

    let revealResult: LoadOlderResult | undefined;
    await act(async () => {
      revealResult = await result.current.onLoadOlder();
    });
    expect(result.current.windowSize).toBe(130);
    expect(revealResult).toEqual({ hasMore: true, prependedCount: STEP });
    expect(fetchOlder).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(result.current.windowSize).toBe(180);

    await act(async () => {
      await result.current.onLoadOlder();
    });
    // Reveal caps growth at the loaded count (200), not 230.
    expect(result.current.windowSize).toBe(200);
    expect(fetchOlder).not.toHaveBeenCalled();

    // Window drained (== loaded count): the next scroll-up finally fetches.
    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(fetchOlder).toHaveBeenCalledTimes(1);
  });

  it("grows by a real prepend's size once the window is drained", async () => {
    const fetchOlder = vi.fn(
      async (): Promise<LoadOlderResult> => ({
        hasMore: true,
        prependedCount: STEP,
      }),
    );
    const { result, rerender } = renderHook(
      (props: { renderableCount: number }) =>
        useConversationRenderWindow({
          renderableCount: props.renderableCount,
          conversationKey: "c",
          fetchOlder,
        }),
      { initialProps: { renderableCount: 200 } },
    );

    // Drain the window to the loaded count (80 → 130 → 180 → 200).
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await result.current.onLoadOlder();
      });
    }
    expect(result.current.windowSize).toBe(200);

    // The drained scroll-up fetches; the page prepends 50 (the caller's state
    // grows the loaded count in lockstep, mirrored by re-rendering).
    await act(async () => {
      await result.current.onLoadOlder();
    });
    rerender({ renderableCount: 250 });
    expect(fetchOlder).toHaveBeenCalledTimes(1);
    expect(result.current.windowSize).toBe(250);
    expect(result.current.canLoadOlder).toBe(true);
  });

  it("latches canLoadOlder off at the hard DOM bound and stops growing/fetching", async () => {
    const fetchOlder = vi.fn(
      async (): Promise<LoadOlderResult> => ({
        hasMore: true,
        prependedCount: 0,
      }),
    );
    const { result } = renderHook(() =>
      useConversationRenderWindow({
        renderableCount: 600,
        conversationKey: "c",
        fetchOlder,
      }),
    );

    // Reveal-grow all the way to the cap.
    for (let i = 0; i < 20 && result.current.windowSize < CAP; i += 1) {
      await act(async () => {
        await result.current.onLoadOlder();
      });
    }
    expect(result.current.windowSize).toBe(CAP);
    expect(result.current.canLoadOlder).toBe(false);
    expect(fetchOlder).not.toHaveBeenCalled();

    // At the bound onLoadOlder is inert — no further grow, no fetch.
    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(result.current.windowSize).toBe(CAP);
    expect(fetchOlder).not.toHaveBeenCalled();
  });

  it("latches canLoadOlder off when the server reports no more older turns", async () => {
    const fetchOlder = vi.fn(
      async (): Promise<LoadOlderResult> => ({
        hasMore: false,
        prependedCount: 0,
      }),
    );
    const { result } = renderHook(() =>
      useConversationRenderWindow({
        renderableCount: 100,
        conversationKey: "c",
        fetchOlder,
      }),
    );

    // Reveal to the loaded count (80 → 100), then the drained scroll-up fetches
    // and gets hasMore:false.
    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(result.current.windowSize).toBe(100);
    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(fetchOlder).toHaveBeenCalledTimes(1);
    expect(result.current.canLoadOlder).toBe(false);
  });

  it("propagates a fetch rejection without fabricating state, and re-arms", async () => {
    const fetchOlder = vi.fn(
      async (): Promise<LoadOlderResult> => ({
        hasMore: false,
        prependedCount: 0,
      }),
    );
    // First scroll-up fetch rejects; the second falls back to the default impl.
    fetchOlder.mockRejectedValueOnce(new Error("older-page boom"));
    const { result } = renderHook(() =>
      useConversationRenderWindow({
        renderableCount: 100,
        conversationKey: "c",
        fetchOlder,
      }),
    );

    // Reveal to the loaded count so the next call reaches the fetch branch.
    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(result.current.windowSize).toBe(100);

    // The fetch rejects — the rejection must surface (useLoadOlderOnScroll is the
    // boundary that catches it), and no paging state is fabricated.
    await act(async () => {
      await expect(result.current.onLoadOlder()).rejects.toThrow(
        "older-page boom",
      );
    });
    expect(fetchOlder).toHaveBeenCalledTimes(1);
    expect(result.current.canLoadOlder).toBe(true);

    // A subsequent scroll-up fetches again (the failure did not latch).
    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(fetchOlder).toHaveBeenCalledTimes(2);
    expect(result.current.canLoadOlder).toBe(false);
  });

  it("resets the window and reveal on a conversation switch", async () => {
    const fetchOlder = vi.fn(
      async (): Promise<LoadOlderResult> => ({
        hasMore: true,
        prependedCount: 0,
      }),
    );
    const { result, rerender } = renderHook(
      (props: { conversationKey: string }) =>
        useConversationRenderWindow({
          renderableCount: 300,
          conversationKey: props.conversationKey,
          fetchOlder,
        }),
      { initialProps: { conversationKey: "c1" } },
    );

    await act(async () => {
      await result.current.onLoadOlder();
    });
    act(() => {
      result.current.revealFullWindow();
    });
    expect(result.current.windowSize).toBeGreaterThan(INITIAL_WINDOW);

    rerender({ conversationKey: "c2" });
    expect(result.current.windowSize).toBe(INITIAL_WINDOW);
    expect(result.current.canLoadOlder).toBe(true);
  });

  it("drops a page that resolves after a mid-flight conversation switch", async () => {
    const { fetchOlder, resolve } = deferredFetch();
    const { result, rerender } = renderHook(
      (props: { conversationKey: string }) =>
        useConversationRenderWindow({
          renderableCount: 90,
          conversationKey: props.conversationKey,
          fetchOlder,
        }),
      { initialProps: { conversationKey: "c1" } },
    );

    // Reveal to the loaded count (80 → 90) so the next call reaches the fetch.
    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(result.current.windowSize).toBe(90);

    // Start the fetch (still pending), then switch conversations underneath it.
    let pending!: Promise<LoadOlderResult>;
    act(() => {
      pending = result.current.onLoadOlder();
    });
    rerender({ conversationKey: "c2" });

    // The stale page resolves with growth + hasMore:false — both must be dropped
    // because it belongs to c1, not the now-active c2.
    await act(async () => {
      resolve({ hasMore: false, prependedCount: 50 });
      await pending;
    });
    expect(result.current.windowSize).toBe(INITIAL_WINDOW);
    expect(result.current.canLoadOlder).toBe(true);
  });

  it("revealFullWindow renders the whole loaded set and tracks a later prepend up to the cap", () => {
    const { result, rerender } = renderHook(
      (props: { renderableCount: number }) =>
        useConversationRenderWindow({
          renderableCount: props.renderableCount,
          conversationKey: "c",
          fetchOlder: async () => ({ hasMore: true, prependedCount: 0 }),
        }),
      { initialProps: { renderableCount: 201 } },
    );

    act(() => {
      result.current.revealFullWindow();
    });
    // A 201-message around-load (pivot centered ~index 100) mounts in full.
    expect(result.current.windowSize).toBe(201);
    // Below the bound with server history left → still loadable.
    expect(result.current.canLoadOlder).toBe(true);

    // A later prepend grows the loaded count; the revealed window follows it,
    // clamped at the hard DOM bound.
    rerender({ renderableCount: 420 });
    expect(result.current.windowSize).toBe(CAP);
    expect(result.current.canLoadOlder).toBe(false);
  });

  it("clamps a fetched prepend's growth at MAX_LOADED_SHELL_WINDOW mid-page", async () => {
    const fetchOlder = vi.fn(
      async (): Promise<LoadOlderResult> => ({
        hasMore: true,
        prependedCount: 100,
      }),
    );
    const { result, rerender } = renderHook(
      (props: { renderableCount: number }) =>
        useConversationRenderWindow({
          renderableCount: props.renderableCount,
          conversationKey: "c",
          fetchOlder,
        }),
      { initialProps: { renderableCount: INITIAL_WINDOW } },
    );

    // Each drained scroll-up fetches a 100-turn page; the fourth grow lands on
    // 380 + 100 and the fetch continuation itself must clamp at the bound.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await result.current.onLoadOlder();
      });
      rerender({ renderableCount: INITIAL_WINDOW + 100 * (i + 1) });
    }
    expect(fetchOlder).toHaveBeenCalledTimes(4);
    expect(result.current.windowSize).toBe(CAP);
    expect(result.current.canLoadOlder).toBe(false);

    // At the bound onLoadOlder is inert even with server history left.
    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(fetchOlder).toHaveBeenCalledTimes(4);
    expect(result.current.windowSize).toBe(CAP);
  });

  it("resets on a null conversation key and stays reset through the next thread", async () => {
    const fetchOlder = vi.fn(
      async (): Promise<LoadOlderResult> => ({
        hasMore: true,
        prependedCount: 0,
      }),
    );
    const { result, rerender } = renderHook(
      (props: { conversationKey: string | null }) =>
        useConversationRenderWindow({
          renderableCount: 90,
          conversationKey: props.conversationKey,
          fetchOlder,
        }),
      { initialProps: { conversationKey: "c1" as string | null } },
    );

    // Grow past the lean window (80 → 90 reveal) and latch a search-jump
    // reveal, then have the overlay unmount the thread (key → null).
    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(result.current.windowSize).toBe(90);
    act(() => {
      result.current.revealFullWindow();
    });

    rerender({ conversationKey: null });
    expect(result.current.windowSize).toBe(INITIAL_WINDOW);
    expect(result.current.canLoadOlder).toBe(true);

    // The next thread opens from the lean window again, fully re-armed.
    rerender({ conversationKey: "c2" });
    expect(result.current.windowSize).toBe(INITIAL_WINDOW);
    expect(result.current.canLoadOlder).toBe(true);
  });

  it("keeps one stable onLoadOlder identity while calling the latest fetchOlder", async () => {
    const firstFetch = vi.fn(
      async (): Promise<LoadOlderResult> => ({
        hasMore: true,
        prependedCount: 0,
      }),
    );
    const secondFetch = vi.fn(
      async (): Promise<LoadOlderResult> => ({
        hasMore: true,
        prependedCount: 0,
      }),
    );
    const { result, rerender } = renderHook(
      (props: { fetchOlder: () => Promise<LoadOlderResult> }) =>
        useConversationRenderWindow({
          renderableCount: 80,
          conversationKey: "c",
          fetchOlder: props.fetchOlder,
        }),
      { initialProps: { fetchOlder: firstFetch } },
    );
    const captured = result.current.onLoadOlder;

    // useLoadOlderOnScroll captures onLoadOlder once, so its identity must
    // hold across prop changes — while the call reads the LATEST impl.
    rerender({ fetchOlder: secondFetch });
    expect(result.current.onLoadOlder).toBe(captured);

    await act(async () => {
      await captured();
    });
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(firstFetch).not.toHaveBeenCalled();
  });

  it("returns a hasMore:false stub for a page stale-dropped by a switch", async () => {
    const { fetchOlder, resolve } = deferredFetch();
    const { result, rerender } = renderHook(
      (props: { conversationKey: string }) =>
        useConversationRenderWindow({
          renderableCount: 90,
          conversationKey: props.conversationKey,
          fetchOlder,
        }),
      { initialProps: { conversationKey: "c1" } },
    );

    // Reveal to the loaded count so the next call reaches the fetch.
    await act(async () => {
      await result.current.onLoadOlder();
    });
    expect(result.current.windowSize).toBe(90);

    let pending!: Promise<LoadOlderResult>;
    act(() => {
      pending = result.current.onLoadOlder();
    });
    rerender({ conversationKey: "c2" });
    await act(async () => {
      resolve({ hasMore: true, prependedCount: 50 });
      // The observer consumes this payload directly: hasMore:false stops its
      // scroll loop, and even a would-grow page is neutralized in the return.
      await expect(pending).resolves.toEqual({
        hasMore: false,
        prependedCount: 0,
      });
    });
    expect(result.current.windowSize).toBe(INITIAL_WINDOW);
  });

  it("revealFullWindow never drops below the lean initial window on a short thread", () => {
    const { result, rerender } = renderHook(
      (props: { renderableCount: number }) =>
        useConversationRenderWindow({
          renderableCount: props.renderableCount,
          conversationKey: "c",
          fetchOlder: async () => ({ hasMore: true, prependedCount: 0 }),
        }),
      { initialProps: { renderableCount: 30 } },
    );

    act(() => {
      result.current.revealFullWindow();
    });
    // A search-jump hit in a 30-turn thread must not shrink the window down to
    // the loaded count — the reveal floors at the lean initial window.
    expect(result.current.windowSize).toBe(INITIAL_WINDOW);
    expect(result.current.canLoadOlder).toBe(true);

    // Later turns landing under the floor keep the floor.
    rerender({ renderableCount: 45 });
    expect(result.current.windowSize).toBe(INITIAL_WINDOW);
  });
});
