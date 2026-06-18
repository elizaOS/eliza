// Contract test: the GUI/TUI views render whatever GET /api/apps/screenshare/
// capabilities returns, and that route returns getScreenshareCapabilities() ===
// detectDesktopControlCapabilities() from @elizaos/plugin-computeruse. This test
// runs the REAL capability detector and asserts:
//   (a) its output is a valid CapabilitiesResponse the view helpers consume
//       without any undefined access, and
//   (b) every real capability key (incl. the headfulGui key the GUI reads to
//       drive its GUI tile) is present.
// If a future computeruse change renames/drops a capability key, this fails —
// catching drift between the real API shape and what the views render.

import {
  type DesktopControlCapabilities,
  detectDesktopControlCapabilities,
} from "@elizaos/plugin-computeruse";
import { describe, expect, it } from "vitest";
// getScreenshareCapabilities() is the exact value the GET /capabilities route
// serializes (routes.ts calls it directly); it lives in session-store and is a
// thin wrapper over detectDesktopControlCapabilities().
import { getScreenshareCapabilities } from "../session-store";
import type {
  CapabilitiesResponse,
  Capability,
} from "./ScreenshareOperatorSurface.helpers";

// getScreenshareCapabilities() in session-store.ts simply returns
// detectDesktopControlCapabilities(); both are public re-exports.
const REAL_CAPABILITY_KEYS: Array<keyof DesktopControlCapabilities> = [
  "screenshot",
  "computerUse",
  "windowList",
  "headfulGui",
];

function asCapabilitiesResponse(
  caps: DesktopControlCapabilities,
  platform: string,
): CapabilitiesResponse {
  return { platform, capabilities: caps };
}

describe("screenshare capabilities contract", () => {
  it("real detectDesktopControlCapabilities returns exactly the keys the views render", () => {
    const caps = detectDesktopControlCapabilities();
    expect(Object.keys(caps).sort()).toEqual([...REAL_CAPABILITY_KEYS].sort());
  });

  it("every real capability is a { available: boolean, tool: string } DTO", () => {
    const caps = detectDesktopControlCapabilities();
    for (const key of REAL_CAPABILITY_KEYS) {
      const capability: Capability = caps[key];
      expect(typeof capability.available).toBe("boolean");
      expect(typeof capability.tool).toBe("string");
      expect(capability.tool.length).toBeGreaterThan(0);
    }
  });

  it("getScreenshareCapabilities() (the GET /capabilities body) matches the real detector keys", () => {
    // session-store.getScreenshareCapabilities is re-exported from the same
    // package; it is the exact value the route serializes.
    const caps = getScreenshareCapabilities();
    expect(Object.keys(caps).sort()).toEqual([...REAL_CAPABILITY_KEYS].sort());
    // The GUI specifically reads capabilities.capabilities.headfulGui — this
    // key must exist or the GUI tile crashes.
    expect(caps.headfulGui).toBeDefined();
    expect(typeof caps.headfulGui.available).toBe("boolean");
  });

  it("the view's CapabilitiesResponse parser consumes the real shape without undefined access", () => {
    const response = asCapabilitiesResponse(
      detectDesktopControlCapabilities(),
      "linux",
    );

    // Mirror exactly what ScreenshareOperatorSurface does:
    //   capabilities?.capabilities.headfulGui?.available
    //   Object.entries(capabilities.capabilities).map(([name, capability]) =>
    //     `${name}: ${capability.tool}` + capability.available)
    expect(typeof response.platform).toBe("string");
    const guiActive = response.capabilities.headfulGui?.available;
    expect(typeof guiActive).toBe("boolean");

    const tiles = Object.entries(response.capabilities).map(
      ([name, capability]) => ({
        title: `${name}: ${capability.tool}`,
        available: capability.available,
      }),
    );
    expect(tiles.length).toBe(REAL_CAPABILITY_KEYS.length);
    // All four real names appear in the rendered tile titles.
    const titles = tiles.map((tile) => tile.title);
    for (const key of REAL_CAPABILITY_KEYS) {
      expect(titles.some((title) => title.startsWith(`${key}:`))).toBe(true);
    }

    // Mirror the TUI viewState capability map: name -> available bool, and the
    // "N live" count the TUI capabilities section shows.
    const map = Object.fromEntries(
      Object.entries(response.capabilities).map(([name, capability]) => [
        name,
        capability.available,
      ]),
    );
    expect(Object.keys(map).sort()).toEqual([...REAL_CAPABILITY_KEYS].sort());
    const liveCount = Object.values(response.capabilities).filter(
      (capability) => capability.available,
    ).length;
    expect(liveCount).toBeGreaterThanOrEqual(0);
    expect(liveCount).toBeLessThanOrEqual(REAL_CAPABILITY_KEYS.length);
  });
});
