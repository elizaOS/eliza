/**
 * Pins the desktop dev stack-status API-port resolution to the canonical
 * `@elizaos/shared/runtime-env` source of truth (#13630 B2).
 *
 * Regression guarded: a drifted local `DEFAULT_API_PORT = 2138` (the *Vite UI*
 * port) previously made a clean-shell probe (no `ELIZA_API_PORT`) check 2138
 * instead of the real desktop API port 31337 — so an API-only stack reported
 * "Nothing listening" and exited 1 while the API was healthy on 31337, and a
 * full stack emitted a contradictory `apiPort: 2138` vs the API's real 31337.
 */

import {
  DEFAULT_DESKTOP_API_PORT,
  DEFAULT_DESKTOP_UI_PORT,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { gatherDesktopStackStatus } from "./desktop-stack-status.mjs";

/** A fetch that never resolves a real endpoint (all probes report failure). */
function makeDeadFetch() {
  return vi.fn(async () => ({
    ok: false,
    status: 0,
    text: async () => "",
  }));
}

/** isPortOpen stub: returns true only for ports in `openPorts`. */
function makePortProbe(openPorts) {
  const set = new Set(openPorts);
  return vi.fn(async (port) => set.has(port));
}

describe("gatherDesktopStackStatus — API port resolution (#13630 B2)", () => {
  it("resolves the canonical desktop API port (31337) in a clean shell, not the Vite UI port", async () => {
    const status = await gatherDesktopStackStatus(
      {}, // clean shell: no ELIZA_API_PORT / ELIZA_PORT
      makeDeadFetch(),
      { isPortOpen: makePortProbe([]) },
    );

    expect(status.apiPort).toBe(DEFAULT_DESKTOP_API_PORT);
    expect(status.apiPort).toBe(31337);
    // Regression guard: must NEVER default the API port to the Vite UI port.
    expect(status.apiPort).not.toBe(DEFAULT_DESKTOP_UI_PORT);
    expect(status.apiPort).not.toBe(2138);
  });

  it("detects an API-only stack listening on 31337 with no ELIZA_API_PORT in the shell", async () => {
    const probe = makePortProbe([DEFAULT_DESKTOP_API_PORT]);
    const status = await gatherDesktopStackStatus({}, makeDeadFetch(), {
      isPortOpen: probe,
    });

    expect(status.apiPort).toBe(31337);
    expect(status.apiListening).toBe(true);
    // The probe must have been asked about the real API port (31337). The UI
    // leg still separately probes 2138 (the Vite UI port) — that's expected and
    // distinct from the API port, which must never itself default to 2138.
    expect(probe).toHaveBeenCalledWith(31337);
    expect(status.uiPort).toBe(2138);
    expect(status.uiPort).not.toBe(status.apiPort);
  });

  it("honors an explicit ELIZA_API_PORT override", async () => {
    const status = await gatherDesktopStackStatus(
      { ELIZA_API_PORT: "45000" },
      makeDeadFetch(),
      { isPortOpen: makePortProbe([45000]) },
    );

    expect(status.apiPort).toBe(45000);
    expect(status.apiListening).toBe(true);
  });

  it("falls back to ELIZA_PORT when ELIZA_API_PORT is unset (first-non-empty wins)", async () => {
    const status = await gatherDesktopStackStatus(
      { ELIZA_PORT: "39000" },
      makeDeadFetch(),
      { isPortOpen: makePortProbe([]) },
    );

    expect(status.apiPort).toBe(39000);
  });

  it("still defaults the UI port to the canonical Vite UI port (2138)", async () => {
    const status = await gatherDesktopStackStatus({}, makeDeadFetch(), {
      isPortOpen: makePortProbe([]),
    });

    expect(status.uiPort).toBe(DEFAULT_DESKTOP_UI_PORT);
    expect(status.uiPort).toBe(2138);
  });
});
