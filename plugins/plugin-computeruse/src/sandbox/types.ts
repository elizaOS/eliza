/**
 * Driver / sandbox-backend types.
 *
 * The `Driver` interface is the single dispatch surface that both the yolo
 * (host) path and the sandbox path implement. Anything that wants to drive a
 * machine — host, Docker container, QEMU VM, future Lume/macOS image —
 * implements this one shape. The mode-selection seam in
 * `services/computer-use-service.ts` picks an instance once at start; nothing
 * downstream branches on `mode`.
 */

import type {
  FileActionResult,
  ProcessInfoLite,
  ScreenRegion,
  TerminalActionResult,
  WindowInfo,
} from "./surface-types.js";

export type ScrollDirection = "up" | "down" | "left" | "right";

/**
 * Single dispatch surface for a CUA executor (host or sandbox).
 *
 * Methods are deliberately kept narrow and primitive. The richer
 * approval/normalisation/screenshot-after-action policy lives one layer up in
 * `ComputerUseService`; the driver only knows how to talk to its target.
 */
export interface Driver {
  /** Stable name for diagnostics + tests. */
  readonly name: string;

  // ── Mouse ───────────────────────────────────────────────────────────────
  mouseMove(x: number, y: number): Promise<void>;
  mouseClick(x: number, y: number): Promise<void>;
  mouseDoubleClick(x: number, y: number): Promise<void>;
  mouseRightClick(x: number, y: number): Promise<void>;
  mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  mouseScroll(
    x: number,
    y: number,
    direction: ScrollDirection,
    amount: number,
  ): Promise<void>;

  // ── Keyboard ────────────────────────────────────────────────────────────
  keyboardType(text: string): Promise<void>;
  keyboardKeyPress(key: string): Promise<void>;
  keyboardHotkey(combo: string): Promise<void>;

  // ── Screenshot ──────────────────────────────────────────────────────────
  screenshot(region?: ScreenRegion): Promise<Buffer>;

  // ── Windows / Processes ─────────────────────────────────────────────────
  listWindows(): Promise<WindowInfo[]>;
  focusWindow(windowId: string): Promise<void>;
  listProcesses(): Promise<ProcessInfoLite[]>;

  // ── Terminal / Files ────────────────────────────────────────────────────
  runCommand(
    command: string,
    options?: { cwd?: string; timeoutSeconds?: number },
  ): Promise<TerminalActionResult>;
  readFile(targetPath: string): Promise<FileActionResult>;
  writeFile(targetPath: string, content: string): Promise<FileActionResult>;

  /** Free any sandbox/container/process resources. Called once at service stop. */
  dispose(): Promise<void>;
}

/**
 * Backend-internal contract: the smallest surface a sandbox backend
 * (Docker / QEMU / Lume / ...) must expose. The `SandboxDriver` proxies every
 * `Driver` method through this. Keeping this separate from `Driver` lets the
 * driver implement coordinate normalisation, screenshot decoding, etc. once
 * for all backends.
 */
export interface SandboxBackend {
  readonly name: string;

  /** Boot the underlying sandbox (start container / VM, install helper). */
  start(): Promise<void>;

  /** Tear down the sandbox. Must be idempotent. */
  stop(): Promise<void>;

  /**
   * Send one command to the in-sandbox helper and get a typed response.
   * Backends are responsible for transport (docker exec, virtio-serial, ...).
   */
  invoke<TResult>(op: SandboxOp): Promise<TResult>;
}

/** Tagged operation envelope sent to the sandbox helper. */
export type SandboxOp =
  | { kind: "screenshot"; region?: ScreenRegion }
  | { kind: "mouse_move"; x: number; y: number }
  | { kind: "mouse_click"; x: number; y: number }
  | { kind: "mouse_double_click"; x: number; y: number }
  | { kind: "mouse_right_click"; x: number; y: number }
  | { kind: "mouse_drag"; x1: number; y1: number; x2: number; y2: number }
  | {
      kind: "mouse_scroll";
      x: number;
      y: number;
      direction: ScrollDirection;
      amount: number;
    }
  | { kind: "keyboard_type"; text: string }
  | { kind: "keyboard_key_press"; key: string }
  | { kind: "keyboard_hotkey"; combo: string }
  | { kind: "list_windows" }
  | { kind: "focus_window"; window_id: string }
  | { kind: "list_processes" }
  | {
      kind: "run_command";
      command: string;
      cwd?: string;
      timeout_seconds?: number;
    }
  | { kind: "read_file"; path: string }
  | { kind: "write_file"; path: string; content: string };

/**
 * Thrown when a backend cannot be constructed (e.g. QEMU stub, missing
 * docker binary). Callers should bubble this to the operator so the
 * misconfiguration is loud, never silent.
 */
export class SandboxBackendUnavailableError extends Error {
  readonly backend: string;
  constructor(message: string, backend: string) {
    super(message);
    this.name = "SandboxBackendUnavailableError";
    this.backend = backend;
  }
}

/** Thrown when the in-sandbox helper returns a structured error. */
export class SandboxInvocationError extends Error {
  readonly op: SandboxOp["kind"];
  constructor(message: string, op: SandboxOp["kind"]) {
    super(message);
    this.name = "SandboxInvocationError";
    this.op = op;
  }
}
