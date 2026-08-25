import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./selectors.js", () => ({
  googleLeaveSelectors: [
    'button[aria-label*="Leave call"]',
    'button[aria-label*="Leave meeting"]',
  ],
}));

import { leaveGoogleMeet } from "./leave.js";

function fakePage() {
  return {
    isClosed: vi.fn(() => false),
    evaluate: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => undefined),
  };
}

describe("leaveGoogleMeet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately when the page is already closed", async () => {
    const page = fakePage();
    page.isClosed.mockReturnValue(true);
    await leaveGoogleMeet(page as never);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it("clicks the first visible leave control and retries for a confirmation dialog", async () => {
    const page = fakePage();
    page.evaluate
      .mockResolvedValueOnce('button[aria-label*="Leave call"]')
      .mockResolvedValueOnce(undefined);
    await leaveGoogleMeet(page as never);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
  });

  it("does not retry when no leave control is visible", async () => {
    const page = fakePage();
    page.evaluate.mockResolvedValue(null);
    await leaveGoogleMeet(page as never);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it("never throws when the evaluate call fails", async () => {
    const page = fakePage();
    page.evaluate.mockRejectedValue(new Error("context destroyed"));
    await expect(leaveGoogleMeet(page as never)).resolves.toBeUndefined();
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it("never throws when the confirmation pass fails", async () => {
    const page = fakePage();
    page.evaluate
      .mockResolvedValueOnce('button[aria-label*="Leave call"]')
      .mockRejectedValueOnce(new Error("dialog vanished"));
    await expect(leaveGoogleMeet(page as never)).resolves.toBeUndefined();
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  it("never throws when isClosed itself reports failure state", async () => {
    const page = fakePage();
    page.isClosed.mockReturnValue(false);
    page.evaluate.mockRejectedValueOnce(new Error("frame detached"));
    await expect(leaveGoogleMeet(page as never)).resolves.toBeUndefined();
  });
});
