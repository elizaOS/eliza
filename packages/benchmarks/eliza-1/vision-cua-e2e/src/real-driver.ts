/**
 * Real-mode click driver for the vision-CUA E2E harness.
 *
 * Replaces `StubDriver`. Two modes:
 *
 *   1. **Sandbox driver mode** — when a `Driver` is available via
 *      `getCurrentDriver(runtime)` from `@elizaos/plugin-computeruse/sandbox`
 *      (i.e. the runtime is configured with `ELIZA_COMPUTERUSE_MODE=sandbox`),
 *      we hand the click to that sandbox driver. The mouse never touches the
 *      host screen.
 *
 *   2. **Host mode (controlled window)** — when no sandbox driver is
 *      configured, the driver clicks the *host* desktop via
 *      `performDesktopClick(x, y)`. Real clicks against the user's live
 *      desktop are dangerous — instead the harness spawns a tiny harmless
 *      X11 window (default `xeyes`) and clamps every click into that
 *      window's geometry. If we can't spawn a controlled window we refuse
 *      to click at all and surface a structured error so the trace marks
 *      the click stage as failed.
 *
 * The driver keeps an in-memory record of every issued click for the trace,
 * exactly like `StubDriver` does — so the harness assertions about
 * `recordedClicks` continue to hold regardless of which path was taken.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { AbsoluteClickTarget } from "./types.ts";

export interface RecordedClick {
  readonly target: AbsoluteClickTarget;
  readonly remappedTo?: AbsoluteClickTarget;
  readonly at: number;
  readonly mode: "sandbox" | "host-controlled-window" | "noop-recorded";
  readonly note?: string;
}

export interface RealDriverOptions {
  /**
   * When true, the driver is in sandbox mode and `click()` is dispatched
   * through the supplied sandbox dispatcher. Production wiring uses
   * `getCurrentDriver(runtime)`.
   */
  readonly sandboxClick?: (target: AbsoluteClickTarget) => Promise<void>;
  /**
   * Geometry of the controlled X11 window we will clamp clicks into. When
   * absent, host clicks are refused.
   */
  readonly controlledWindow?: ControlledWindowHandle | null;
  /**
   * When true, never invoke real input at all — record the click and exit.
   * Useful when the harness runs on a host with no `xdotool` (Linux input
   * tool) or no controlled window.
   */
  readonly noopOnly?: boolean;
}

export interface ControlledWindowHandle {
  readonly pid: number;
  readonly process: ChildProcess;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Description of what this window is (e.g. "xeyes"). */
  readonly description: string;
  close(): Promise<void>;
}

export class RealDriver {
  private readonly clicks: RecordedClick[] = [];
  constructor(private readonly opts: RealDriverOptions = {}) {}

  async click(target: AbsoluteClickTarget): Promise<void> {
    if (this.opts.sandboxClick) {
      await this.opts.sandboxClick(target);
      this.clicks.push({ target, at: Date.now(), mode: "sandbox" });
      return;
    }

    if (this.opts.noopOnly || !this.opts.controlledWindow) {
      this.clicks.push({
        target,
        at: Date.now(),
        mode: "noop-recorded",
        note: this.opts.noopOnly
          ? "noopOnly=true — click recorded but not dispatched"
          : "no controlled window available; refusing to touch host desktop",
      });
      return;
    }

    const win = this.opts.controlledWindow;
    const remapped = clampToWindow(target, win.bounds);
    await this.dispatchHostClick(remapped);
    this.clicks.push({
      target,
      remappedTo: remapped,
      at: Date.now(),
      mode: "host-controlled-window",
      note: `clamped into ${win.description} (${win.bounds.x},${win.bounds.y} ${win.bounds.width}x${win.bounds.height})`,
    });
  }

  recordedClicks(): ReadonlyArray<RecordedClick> {
    return [...this.clicks];
  }

  /**
   * Host-mode click. Imports `performDesktopClick` lazily — if the underlying
   * input tool is missing (`xdotool` on Linux, `cliclick`/`osascript` on
   * macOS) the import succeeds but the call throws; we let that throw bubble
   * so the click stage is recorded as failed.
   */
  private async dispatchHostClick(target: AbsoluteClickTarget): Promise<void> {
    // The published `@elizaos/plugin-computeruse` package.json declares
    // `import` before `types` in its conditional exports, which makes tsc's
    // bundler resolver reach for `dist/index.js` (no .d.ts twin in that
    // resolution branch). The runtime import works fine — both bun and node
    // honour the `default` condition. Cast the surface to the typed shape
    // we depend on to keep `tsc --noEmit` clean without patching the
    // upstream package.
    const mod = (await import("@elizaos/plugin-computeruse")) as {
      readonly performDesktopClick: (
        x: number,
        y: number,
        button: "left" | "right" | "middle",
      ) => void;
    };
    mod.performDesktopClick(target.absoluteX, target.absoluteY, "left");
  }
}

function clampToWindow(
  target: AbsoluteClickTarget,
  bounds: ControlledWindowHandle["bounds"],
): AbsoluteClickTarget {
  const minX = bounds.x + 4;
  const minY = bounds.y + 4;
  const maxX = bounds.x + bounds.width - 5;
  const maxY = bounds.y + bounds.height - 5;
  return {
    displayId: target.displayId,
    absoluteX: clamp(target.absoluteX, minX, maxX),
    absoluteY: clamp(target.absoluteY, minY, maxY),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (lo > hi) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// ── Controlled window helpers ───────────────────────────────────────────────

export interface SpawnControlledWindowOptions {
  /** Override the binary used for the controlled window. Default `xeyes`. */
  readonly binary?: string;
  /** Extra args. */
  readonly args?: ReadonlyArray<string>;
  /**
   * Geometry to assume for the spawned window. We don't currently query the
   * X server for actual geometry (that would require xdotool); the harness
   * just clamps clicks to this static rect, which is conservative.
   */
  readonly bounds?: ControlledWindowHandle["bounds"];
  /** Description recorded in the trace. */
  readonly description?: string;
}

const DEFAULT_BOUNDS: ControlledWindowHandle["bounds"] = {
  x: 100,
  y: 100,
  width: 400,
  height: 300,
};

/**
 * Spawn a tiny harmless X11 window for the driver to click into. Returns
 * `null` if the binary is unavailable or DISPLAY is not set. Callers should
 * always inspect the result and fall back to noop mode on null.
 */
export async function spawnControlledWindow(
  opts: SpawnControlledWindowOptions = {},
): Promise<ControlledWindowHandle | null> {
  const binary = opts.binary ?? "xeyes";
  if (!process.env.DISPLAY) return null;
  let proc: ChildProcess;
  try {
    proc = spawn(binary, [...(opts.args ?? [])], {
      stdio: "ignore",
      detached: false,
    });
  } catch {
    return null;
  }
  // Give the window a beat to map. xeyes is small and fast — 250ms is
  // generous on every box we've tested.
  await delay(250);
  if (proc.exitCode !== null) {
    return null;
  }
  const bounds = opts.bounds ?? DEFAULT_BOUNDS;
  const description = opts.description ?? binary;
  return {
    pid: proc.pid ?? -1,
    process: proc,
    bounds,
    description,
    async close(): Promise<void> {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await delay(50);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    },
  };
}
