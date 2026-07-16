/**
 * @vitest-environment jsdom
 *
 * Proves the side-effect boot module wires the LifeOps activity-signal capture:
 * importing `register.ts` calls `startLifeOpsActivitySignalCapture()` exactly
 * once with no arguments (defaulting `enabled` to true). The capture module is
 * mocked so the real listeners/intervals are covered by its own suite and never
 * leak from this import-time boot.
 */
import { describe, expect, it, vi } from "vitest";

const startSpy = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("./lifeops/activity-signals-capture.js", () => ({
  startLifeOpsActivitySignalCapture: startSpy,
}));

import "./register.js";

describe("register boot module", () => {
  it("starts the LifeOps activity-signal capture once on import", () => {
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith();
  });
});
