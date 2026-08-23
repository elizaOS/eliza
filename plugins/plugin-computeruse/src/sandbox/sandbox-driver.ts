/**
 * `SandboxDriver` — implements the host-equivalent `Driver` interface by
 * proxying every CUA op to a `SandboxBackend`. The mode-selection seam in
 * `services/computer-use-service.ts` instantiates either this or the host
 * driver exactly once at start; nothing downstream knows which.
 *
 * Inspired by the architecture of trycua/cua's BaseComputer/BaseProvider split
 * (MIT, https://github.com/trycua/cua) — but a clean re-implementation. We
 * make no runtime dependency on the trycua Python library.
 */

import type {
  FileActionResult,
  ProcessInfoLite,
  ScreenRegion,
  TerminalActionResult,
  WindowInfo,
} from "./surface-types.js";
import type { Driver, SandboxBackend, ScrollDirection } from "./types.js";

/**
 * Backend response shape for the `screenshot` op. Backends MUST encode bytes
 * as base64 PNG on the wire.
 */
interface ScreenshotResponse {
  base64Png: string;
}

interface ListWindowsResponse {
  windows: WindowInfo[];
}

interface ListProcessesResponse {
  processes: ProcessInfoLite[];
}

export class SandboxDriver implements Driver {
  readonly name: string;
  /**
   * Memoized in-flight (or resolved) boot. `null` means "never booted".
   * We store the promise itself — not a `started` boolean that only flips
   * after `start()` resolves — so concurrent first ops share one boot and a
   * `dispose()` that races the boot can still await and tear it down. Reset to
   * `null` only when the boot rejects (so a later op can retry) or after a
   * successful `dispose()`.
   */
  private startPromise: Promise<void> | null = null;

  constructor(private readonly backend: SandboxBackend) {
    this.name = `sandbox:${backend.name}`;
  }

  /**
   * Lazily boots the backend on first op. Idempotent and concurrency-safe:
   * N ops racing the first boot all await the same `backend.start()` call, so
   * the backend is started exactly once. If the boot rejects, the memo is
   * cleared so the next op retries instead of awaiting a permanently failed
   * promise.
   */
  private async ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      const boot = this.backend.start();
      this.startPromise = boot;
      try {
        await boot;
      } catch (err) {
        // error-policy:J2 boot failed — clear the memo so a later op can retry
        // a fresh start(), then rethrow the typed backend error to the caller.
        if (this.startPromise === boot) this.startPromise = null;
        throw err;
      }
      return;
    }
    await this.startPromise;
  }

  // ── Mouse ────────────────────────────────────────────────────────────────

  async mouseMove(x: number, y: number): Promise<void> {
    await this.ensureStarted();
    await this.backend.invoke<void>({ kind: "mouse_move", x, y });
  }

  async mouseClick(x: number, y: number): Promise<void> {
    await this.ensureStarted();
    await this.backend.invoke<void>({ kind: "mouse_click", x, y });
  }

  async mouseDoubleClick(x: number, y: number): Promise<void> {
    await this.ensureStarted();
    await this.backend.invoke<void>({ kind: "mouse_double_click", x, y });
  }

  async mouseRightClick(x: number, y: number): Promise<void> {
    await this.ensureStarted();
    await this.backend.invoke<void>({ kind: "mouse_right_click", x, y });
  }

  async mouseDrag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): Promise<void> {
    await this.ensureStarted();
    await this.backend.invoke<void>({ kind: "mouse_drag", x1, y1, x2, y2 });
  }

  async mouseScroll(
    x: number,
    y: number,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void> {
    await this.ensureStarted();
    await this.backend.invoke<void>({
      kind: "mouse_scroll",
      x,
      y,
      direction,
      amount,
    });
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  async keyboardType(text: string): Promise<void> {
    await this.ensureStarted();
    await this.backend.invoke<void>({ kind: "keyboard_type", text });
  }

  async keyboardKeyPress(key: string): Promise<void> {
    await this.ensureStarted();
    await this.backend.invoke<void>({ kind: "keyboard_key_press", key });
  }

  async keyboardHotkey(combo: string): Promise<void> {
    await this.ensureStarted();
    await this.backend.invoke<void>({ kind: "keyboard_hotkey", combo });
  }

  // ── Screenshot ───────────────────────────────────────────────────────────

  async screenshot(region?: ScreenRegion): Promise<Buffer> {
    await this.ensureStarted();
    const response = await this.backend.invoke<ScreenshotResponse>({
      kind: "screenshot",
      region,
    });
    return Buffer.from(response.base64Png, "base64");
  }

  // ── Windows / Processes ──────────────────────────────────────────────────

  async listWindows(): Promise<WindowInfo[]> {
    await this.ensureStarted();
    const response = await this.backend.invoke<ListWindowsResponse>({
      kind: "list_windows",
    });
    return response.windows;
  }

  async focusWindow(windowId: string): Promise<void> {
    await this.ensureStarted();
    await this.backend.invoke<void>({
      kind: "focus_window",
      window_id: windowId,
    });
  }

  async listProcesses(): Promise<ProcessInfoLite[]> {
    await this.ensureStarted();
    const response = await this.backend.invoke<ListProcessesResponse>({
      kind: "list_processes",
    });
    return response.processes;
  }

  // ── Terminal / Files ─────────────────────────────────────────────────────

  async runCommand(
    command: string,
    options?: { cwd?: string; timeoutSeconds?: number },
  ): Promise<TerminalActionResult> {
    await this.ensureStarted();
    return this.backend.invoke<TerminalActionResult>({
      kind: "run_command",
      command,
      cwd: options?.cwd,
      timeout_seconds: options?.timeoutSeconds,
    });
  }

  async readFile(targetPath: string): Promise<FileActionResult> {
    await this.ensureStarted();
    return this.backend.invoke<FileActionResult>({
      kind: "read_file",
      path: targetPath,
    });
  }

  async writeFile(
    targetPath: string,
    content: string,
  ): Promise<FileActionResult> {
    await this.ensureStarted();
    return this.backend.invoke<FileActionResult>({
      kind: "write_file",
      path: targetPath,
      content,
    });
  }

  /**
   * Tears down the backend. Safe to call at any point in the lifecycle,
   * including while a first-op boot is still in flight: it awaits the pending
   * boot (so a `docker run` that is mid-flight is not orphaned) and then stops
   * the backend. A dispose before any op ever ran is a no-op. If the boot
   * itself failed there is nothing running to stop.
   */
  async dispose(): Promise<void> {
    const pending = this.startPromise;
    if (!pending) return;
    this.startPromise = null;
    try {
      await pending;
    } catch {
      // error-policy:J4 the boot rejected; the backend never came up, so there
      // is nothing to stop. The original start() error was already surfaced to
      // whichever op triggered the boot.
      return;
    }
    await this.backend.stop();
  }
}
