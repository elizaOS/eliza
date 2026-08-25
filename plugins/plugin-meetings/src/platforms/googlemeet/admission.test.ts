import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/selectors.js", () => ({
  anySelectorPresent: vi.fn(async () => false),
  anySelectorVisible: vi.fn(async () => false),
}));

vi.mock("./selectors.js", () => ({
  googleInitialAdmissionIndicators: [
    "[data-participant-id]",
    "[data-self-name]",
    'button[aria-label*="Join now"]',
  ],
  googleRejectionIndicators: ['[aria-label*="Return to home screen"]'],
  googleWaitingRoomIndicators: ['[aria-label*="waiting room"]'],
}));

import { anySelectorPresent, anySelectorVisible } from "../shared/selectors.js";
import {
  checkAdmissionSilent,
  checkForAdmission,
  checkForRejection,
  hasRecaptchaChallenge,
  waitForAdmission,
} from "./admission.js";

interface LocatorBehavior {
  count?: number;
  visible?: boolean;
  ariaDisabled?: string | null;
  throws?: boolean;
}

function fakePage(
  behavior: (selector: string) => LocatorBehavior = () => ({}),
  frames: { url: () => string }[] = [],
) {
  const locator = vi.fn((selector: string) => {
    const b = behavior(selector);
    const probe = {
      isVisible: vi.fn(async () => {
        if (b.throws) throw new Error("detached");
        return b.visible ?? false;
      }),
      getAttribute: vi.fn(async (attr: string) =>
        attr === "aria-disabled" ? (b.ariaDisabled ?? null) : null,
      ),
      count: vi.fn(async () => b.count ?? 0),
    };
    return {
      first: () => probe,
      count: probe.count,
    };
  });
  return {
    locator,
    frames: vi.fn(() => frames),
    mouse: { move: vi.fn(async () => undefined) },
    // Register a real (faked) timer so the poll loop suspends until the test
    // advances time, mirroring playwright's waitForTimeout.
    waitForTimeout: vi.fn(
      (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    ),
  };
}

describe("hasRecaptchaChallenge", () => {
  it("detects a recaptcha frame by url", async () => {
    const page = fakePage(
      () => ({}),
      [{ url: () => "https://www.google.com/recaptcha/enterprise.js" }],
    );
    await expect(hasRecaptchaChallenge(page as never)).resolves.toBe(true);
  });

  it("falls back to the visible recaptcha iframe probe", async () => {
    const page = fakePage(() => ({ visible: true }));
    await expect(hasRecaptchaChallenge(page as never)).resolves.toBe(true);
  });

  it("returns false when no captcha signal exists", async () => {
    const page = fakePage(() => ({ visible: false }));
    await expect(hasRecaptchaChallenge(page as never)).resolves.toBe(false);
  });

  it("returns false when the probe throws", async () => {
    const page = fakePage(() => ({ throws: true }));
    await expect(hasRecaptchaChallenge(page as never)).resolves.toBe(false);
  });
});

const REJECTION_SELECTOR = '[aria-label*="Return to home screen"]';

function rejectionVisiblePage() {
  return fakePage((selector) => ({
    visible: selector === REJECTION_SELECTOR,
  }));
}

describe("checkForRejection", () => {
  it("reports rejection when the indicator is visible without a captcha", async () => {
    const page = rejectionVisiblePage();
    await expect(checkForRejection(page as never)).resolves.toBe(true);
  });

  it("does not report rejection when a captcha renders the same affordance", async () => {
    const page = fakePage(
      () => ({ visible: selector === REJECTION_SELECTOR }),
      [{ url: () => "https://www.google.com/recaptcha/enterprise.js" }],
    );
    await expect(checkForRejection(page as never)).resolves.toBe(false);
  });

  it("returns false when no rejection indicator is visible", async () => {
    const page = fakePage(() => ({ visible: false }));
    await expect(checkForRejection(page as never)).resolves.toBe(false);
  });

  it("absorbs locator failures and keeps checking other selectors", async () => {
    const page = fakePage(() => ({ throws: true }));
    await expect(checkForRejection(page as never)).resolves.toBe(false);
  });
});

describe("checkForAdmission", () => {
  it("denies admission while a waiting-room indicator is visible", async () => {
    vi.mocked(anySelectorVisible).mockResolvedValueOnce(true);
    const page = fakePage(() => ({}));
    await expect(checkForAdmission(page as never)).resolves.toBe(false);
    expect(page.mouse.move).not.toHaveBeenCalled();
  });

  it("admits on structural selector presence", async () => {
    const page = fakePage((selector) => ({
      count: selector === "[data-participant-id]" ? 1 : 0,
    }));
    await expect(checkForAdmission(page as never)).resolves.toBe(true);
  });

  it("admits on a visible, enabled toolbar button", async () => {
    const page = fakePage((selector) => ({
      visible: selector === 'button[aria-label*="Join now"]',
      ariaDisabled:
        selector === 'button[aria-label*="Join now"]' ? "false" : null,
    }));
    await expect(checkForAdmission(page as never)).resolves.toBe(true);
  });

  it("skips aria-disabled toolbar buttons and falls back to presence", async () => {
    const page = fakePage((selector) => ({
      visible: selector === 'button[aria-label*="Join now"]',
      ariaDisabled:
        selector === 'button[aria-label*="Join now"]' ? "true" : null,
    }));
    vi.mocked(anySelectorPresent).mockResolvedValueOnce(true);
    await expect(checkForAdmission(page as never)).resolves.toBe(true);
    expect(anySelectorPresent).toHaveBeenCalled();
  });

  it("denies admission when no signal is present", async () => {
    const page = fakePage(() => ({}));
    await expect(checkForAdmission(page as never)).resolves.toBe(false);
  });
});

describe("checkAdmissionSilent", () => {
  it("is a side-effect-free admission probe", async () => {
    const page = fakePage(() => ({}));
    await expect(checkAdmissionSilent(page as never)).resolves.toBe(false);
  });
});

describe("waitForAdmission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns admitted immediately when already in the call", async () => {
    const page = fakePage(() => ({ count: 1 }));
    await expect(
      waitForAdmission(page as never, new AbortController().signal, 10_000),
    ).resolves.toBe("admitted");
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it("returns rejected immediately when rejected", async () => {
    const page = rejectionVisiblePage();
    await expect(
      waitForAdmission(page as never, new AbortController().signal, 10_000),
    ).resolves.toBe("rejected");
  });

  it("polls until admitted", async () => {
    let admissionVisible = false;
    const page = fakePage((selector) => ({
      count: !admissionVisible && selector === "[data-participant-id]" ? 0 : 1,
    }));
    const promise = waitForAdmission(
      page as never,
      new AbortController().signal,
      10_000,
    );
    await vi.advanceTimersByTimeAsync(0);
    admissionVisible = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe("admitted");
  });

  it("returns timeout when the session signal aborts", async () => {
    const controller = new AbortController();
    const page = fakePage(() => ({}));
    const promise = waitForAdmission(page as never, controller.signal, 10_000);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe("timeout");
  });

  it("returns timeout after the window elapses without a terminal state", async () => {
    const page = fakePage(() => ({}));
    const promise = waitForAdmission(
      page as never,
      new AbortController().signal,
      6_000,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(promise).resolves.toBe("timeout");
  });

  it("returns rejected when a rejection appears during the wait", async () => {
    let rejectedDuringWait = false;
    const page = fakePage((selector) => ({
      visible:
        rejectedDuringWait &&
        selector === '[aria-label*="Return to home screen"]',
    }));
    const promise = waitForAdmission(
      page as never,
      new AbortController().signal,
      10_000,
    );
    await vi.advanceTimersByTimeAsync(0);
    rejectedDuringWait = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe("rejected");
  });
});
