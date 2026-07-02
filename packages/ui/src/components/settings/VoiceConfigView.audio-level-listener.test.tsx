// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIX 2 — WakeWordSection audioLevel listener leak (VoiceConfigView.tsx).
 *
 * The mic-meter effect awaited `getSwabblePlugin().addListener("audioLevel")`
 * inside a void async IIFE with no cancelled flag: when the section unmounted
 * before the promise resolved, cleanup saw `handle === null` and the native
 * listener leaked (kept firing into a dead meter ref forever). The fix mirrors
 * useWakeController: a `cancelled` flag set in cleanup, and a post-await
 * `if (cancelled) void h.remove()` on the freshly resolved handle.
 */

const h = vi.hoisted(() => {
  const state = {
    audioLevelResolvers: [] as Array<() => void>,
    removeCalls: 0,
  };
  const swabblePlugin = {
    getConfig: () => Promise.resolve({ config: null }),
    isListening: () => Promise.resolve({ listening: false }),
    updateConfig: () => Promise.resolve({}),
    start: () => Promise.resolve({ started: true }),
    stop: () => Promise.resolve({ stopped: true }),
    addListener: (_event: string, _cb: (ev: unknown) => void) => {
      // Deferred on purpose — the tests control when the native bridge
      // "responds", so they can unmount while the call is still in flight.
      return new Promise<{ remove: () => Promise<void> }>((resolve) => {
        state.audioLevelResolvers.push(() =>
          resolve({
            remove: () => {
              state.removeCalls += 1;
              return Promise.resolve();
            },
          }),
        );
      });
    },
  };
  return { state, swabblePlugin };
});

vi.mock("../../state", () => ({
  useAppSelector: (
    sel: (value: Record<string, unknown>) => unknown,
    // biome-ignore lint/suspicious/noExplicitAny: test shim over the app store
  ): any =>
    sel({
      t: (_key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? _key,
      characterData: { name: "eliza" },
      agentStatus: { agentName: "eliza" },
    }),
}));

vi.mock("../../bridge/native-plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../bridge/native-plugins")>()),
  getSwabblePlugin: () => h.swabblePlugin as never,
}));

import { WakeWordSection } from "./VoiceConfigView";

describe("WakeWordSection audioLevel listener lifecycle (FIX 2)", () => {
  beforeEach(() => {
    h.state.audioLevelResolvers.length = 0;
    h.state.removeCalls = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("removes the native listener when addListener resolves after unmount", async () => {
    const { unmount } = render(<WakeWordSection />);

    // The meter effect has asked the native bridge for a listener…
    await waitFor(() =>
      expect(h.state.audioLevelResolvers.length).toBeGreaterThanOrEqual(1),
    );

    // …but the section unmounts before the bridge responds.
    unmount();
    expect(h.state.removeCalls).toBe(0);

    // The late resolution must be removed immediately, not leaked.
    for (const resolve of h.state.audioLevelResolvers.splice(0)) resolve();
    await waitFor(() => expect(h.state.removeCalls).toBe(1));
  });

  it("removes a fully-registered listener on unmount (control case)", async () => {
    const { unmount } = render(<WakeWordSection />);

    await waitFor(() =>
      expect(h.state.audioLevelResolvers.length).toBeGreaterThanOrEqual(1),
    );
    for (const resolve of h.state.audioLevelResolvers.splice(0)) resolve();
    // Let the effect store the resolved handle.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.state.removeCalls).toBe(0);

    unmount();
    await waitFor(() => expect(h.state.removeCalls).toBe(1));
  });
});
