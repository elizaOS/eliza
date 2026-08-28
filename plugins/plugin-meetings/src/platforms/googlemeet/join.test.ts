/**
 * Google Meet guest join flow.
 *
 * Behavioral contracts pinned here:
 *  - The mute/camera probes are BEST-EFFORT: a missing toggle must never abort
 *    the join (mic/camera privacy toggles are raced against the FULL ordered
 *    selector list, including locale fallbacks).
 *  - A missing name input or join button fails LOUD (no silent "joined").
 *  - The mute probe uses the same selector-racing helper as the rest of the
 *    flow, so rotated/obfuscated structural selectors fall back to the
 *    English-text selectors instead of leaving the mic unmuted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { joinGoogleMeeting } from "./join";
import {
  googleCameraButtonSelectors,
  googleJoinButtonSelectors,
  googleMicrophoneButtonSelectors,
  googleNameInputSelectors,
} from "./selectors";

const NAME_SELECTORS = googleNameInputSelectors;
const MIC_SELECTORS = googleMicrophoneButtonSelectors;
const CAM_SELECTORS = googleCameraButtonSelectors;
const JOIN_SELECTORS = googleJoinButtonSelectors;

type SelectorPlan = Map<string, { resolve: boolean; handle?: unknown }>;

function makePage(plan: SelectorPlan) {
  return {
    goto: vi.fn(async () => {}),
    bringToFront: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    waitForSelector: vi.fn((selector: string) => {
      const behavior = plan.get(selector);
      if (behavior?.resolve) {
        return Promise.resolve(
          behavior.handle ?? { isMockHandle: true, selector },
        );
      }
      return Promise.reject(new Error(`timeout waiting for ${selector}`));
    }),
  };
}

function makeInput() {
  return {
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
  };
}

const SESSION = {
  config: {
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    botName: "TestBot",
  },
};

describe("joinGoogleMeeting", () => {
  let page: ReturnType<typeof makePage>;
  let input: ReturnType<typeof makeInput>;
  let plan: SelectorPlan;

  beforeEach(() => {
    plan = new Map();
    page = makePage(plan);
    input = makeInput();
  });

  function resolveAll(selectors: readonly string[]) {
    for (const s of selectors) plan.set(s, { resolve: true });
  }

  it("navigates to the meeting URL and waits for the name input", async () => {
    resolveAll(NAME_SELECTORS);
    resolveAll(JOIN_SELECTORS);
    await joinGoogleMeeting(page as never, SESSION as never, input as never);
    expect(page.goto).toHaveBeenCalledWith(SESSION.config.meetingUrl, {
      waitUntil: "domcontentloaded",
    });
    expect(page.bringToFront).toHaveBeenCalled();
    expect(page.waitForTimeout).toHaveBeenCalledWith(1000);
    expect(input.fill).toHaveBeenCalledWith(
      page,
      expect.objectContaining({ selector: NAME_SELECTORS[0] }),
      SESSION.config.botName,
    );
  });

  it("fails loud when the name input cannot be located", async () => {
    // No name selector matches; join button would match but must never be reached.
    resolveAll(JOIN_SELECTORS);
    await expect(
      joinGoogleMeeting(page as never, SESSION as never, input as never),
    ).rejects.toThrow(/could not locate name input/);
    expect(input.fill).not.toHaveBeenCalled();
    expect(input.click).not.toHaveBeenCalled();
  });

  it("clicks the join button after filling the name", async () => {
    resolveAll(NAME_SELECTORS);
    resolveAll(JOIN_SELECTORS);
    await joinGoogleMeeting(page as never, SESSION as never, input as never);
    expect(input.click).toHaveBeenCalledWith(
      page,
      expect.objectContaining({ selector: JOIN_SELECTORS[0] }),
    );
  });

  it("fails loud when the join button never appears", async () => {
    resolveAll(NAME_SELECTORS);
    // Join selectors all time out.
    await expect(
      joinGoogleMeeting(page as never, SESSION as never, input as never),
    ).rejects.toThrow(/could not locate join button/);
  });

  it("mutes via a fallback selector when the primary structural selector rotates", async () => {
    // Regression: the mute probe used to check selectors[0] only, so a
    // rotated/obfuscated structural selector left the mic ON while logging
    // "already off or not present". The probe must race the whole list.
    resolveAll(NAME_SELECTORS);
    resolveAll(JOIN_SELECTORS);
    // Primary mic selector rotated away; English-text fallback matches.
    plan.set(MIC_SELECTORS[0], { resolve: false });
    plan.set(MIC_SELECTORS[1], {
      resolve: true,
      handle: { micFallback: true },
    });
    // Camera toggle not present at all.
    for (const s of CAM_SELECTORS) plan.set(s, { resolve: false });

    await joinGoogleMeeting(page as never, SESSION as never, input as never);

    expect(input.click).toHaveBeenCalledWith(
      page,
      expect.objectContaining({ micFallback: true }),
    );
    expect(input.click).not.toHaveBeenCalledWith(
      page,
      expect.objectContaining({ selector: MIC_SELECTORS[0] }),
    );
  });

  it("proceeds with the join when mute toggles are absent (best-effort privacy)", async () => {
    resolveAll(NAME_SELECTORS);
    resolveAll(JOIN_SELECTORS);
    for (const s of [...MIC_SELECTORS, ...CAM_SELECTORS]) {
      plan.set(s, { resolve: false });
    }
    await joinGoogleMeeting(page as never, SESSION as never, input as never);
    expect(input.click).toHaveBeenCalledTimes(1);
    expect(input.click).toHaveBeenCalledWith(
      page,
      expect.objectContaining({ selector: JOIN_SELECTORS[0] }),
    );
  });
});
