/**
 * STUB FOR HARNESS WIRING — replace with the real plugin-computeruse driver
 * (`performDesktopClick` from plugins/plugin-computeruse/src/services/desktop-control.ts)
 * before treating any results as real benchmarks.
 *
 * In stub mode the harness must not move the OS mouse, so the real `click()`
 * is replaced by an in-memory record of the (displayId, x, y) tuple. The
 * real-mode driver in `pipeline.ts::runReal()` should import:
 *
 *   import { performDesktopClick } from "@elizaos/plugin-computeruse";
 *   import { captureAllDisplays, captureDisplay } from
 *     "@elizaos/plugin-computeruse/dist/platform/capture.js";
 *
 * and substitute those for `StubDriver.click()` / `StubFixtureSource.capture*()`.
 */

import type { AbsoluteClickTarget } from "../types.ts";

export interface RecordedClick {
  readonly target: AbsoluteClickTarget;
  readonly at: number;
}

export class StubDriver {
  private readonly clicks: RecordedClick[] = [];

  // biome-ignore lint/suspicious/useAwait: matches the async surface of the real driver
  async click(target: AbsoluteClickTarget): Promise<void> {
    this.clicks.push({ target, at: Date.now() });
  }

  recordedClicks(): ReadonlyArray<RecordedClick> {
    return [...this.clicks];
  }
}
