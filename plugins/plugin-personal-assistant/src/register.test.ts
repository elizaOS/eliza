/**
 * @vitest-environment jsdom
 *
 * Proves the side-effect boot module wires the LifeOps activity-signal capture
 * with the #16504 renderer-scope contract: importing `register.ts` starts the
 * capture exactly once (no arguments — `enabled` defaults true) in the primary
 * app renderer, and starts nothing in excluded window shells (popouts, detached
 * shells, phone companion, app windows, model tester). The capture module is
 * mocked so the real listeners/intervals are covered by its own suite and never
 * leak from this import-time boot; `isPrimaryAppRenderer` is mocked because the
 * real predicate is unit-tested in @elizaos/ui (platform/window-shell.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  isPrimary: vi.fn(() => true),
  start: vi.fn((): (() => void) => () => {}),
}));

vi.mock("@elizaos/ui/platform", () => ({
  isPrimaryAppRenderer: h.isPrimary,
}));

vi.mock("./lifeops/activity-signals-capture.js", () => ({
  startLifeOpsActivitySignalCapture: h.start,
}));

describe("register boot module", () => {
  beforeEach(() => {
    vi.resetModules();
    h.isPrimary.mockReset().mockReturnValue(true);
    h.start.mockReset().mockImplementation(() => () => {});
  });

  it("starts the capture exactly once on import in the primary renderer", async () => {
    await import("./register.js");
    expect(h.isPrimary).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledWith();

    // A second import of the cached module never re-evaluates the boot.
    await import("./register.js");
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("starts nothing outside the primary renderer scope", async () => {
    h.isPrimary.mockReturnValue(false);
    await import("./register.js");
    expect(h.isPrimary).toHaveBeenCalledTimes(1);
    expect(h.start).not.toHaveBeenCalled();
  });
});
