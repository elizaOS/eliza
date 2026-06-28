import { describe, expect, it } from "vitest";
import { computeVrmPausePolicy } from "./vrm-pause-policy";

// #9141: the VRM avatar is the heaviest GPU/battery cost. These pin the gating
// so the render loop only runs when the avatar is actually producing useful
// pixels — active, on screen, and (the tab visible OR opted into animate-hidden).

const base = {
  active: true,
  onScreen: true,
  docVisible: true,
  animateHidden: false,
};

describe("computeVrmPausePolicy (#9141)", () => {
  it("runs full-rate when active, on screen, and the tab is visible", () => {
    expect(computeVrmPausePolicy(base)).toEqual({
      paused: false,
      halfFramerateWhileHidden: false,
    });
  });

  it("pauses when inactive", () => {
    expect(computeVrmPausePolicy({ ...base, active: false }).paused).toBe(true);
  });

  it("pauses when scrolled offscreen even if visible + active", () => {
    expect(computeVrmPausePolicy({ ...base, onScreen: false }).paused).toBe(
      true,
    );
  });

  it("pauses on a hidden tab by default (no animate-when-hidden)", () => {
    expect(computeVrmPausePolicy({ ...base, docVisible: false }).paused).toBe(
      true,
    );
  });

  it("keeps rendering at HALF rate on a hidden tab when animate-when-hidden is on", () => {
    expect(
      computeVrmPausePolicy({
        ...base,
        docVisible: false,
        animateHidden: true,
      }),
    ).toEqual({ paused: false, halfFramerateWhileHidden: true });
  });

  it("offscreen still wins over animate-when-hidden (no point rendering offscreen)", () => {
    const p = computeVrmPausePolicy({
      ...base,
      onScreen: false,
      docVisible: false,
      animateHidden: true,
    });
    expect(p.paused).toBe(true);
    expect(p.halfFramerateWhileHidden).toBe(false);
  });
});
