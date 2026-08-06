/**
 * Stubs for terminal-only APIs used in src/components/.
 * Import these in web-compatible code instead of the real Node.js APIs.
 *
 * These are no-ops / sensible defaults so components that conditionally use
 * terminal features don't crash in the browser.
 */

import { isWeb } from "./platform";

// ─── process.stdout stubs ────────────────────────────────────────────────────

/** Terminal column count (characters wide). Falls back to window character width. */
export function getColumns(): number {
  if (isWeb) {
    // Approximate character columns: window width / ~8px per monospace char
    if (typeof window !== "undefined") {
      return Math.floor(window.innerWidth / 8);
    }
    return 120;
  }
  return (typeof process !== "undefined" && process.stdout?.columns) || 80;
}

/** Terminal row count. Falls back to window character height. */
export function getRows(): number {
  if (isWeb) {
    if (typeof window !== "undefined") {
      return Math.floor(window.innerHeight / 16);
    }
    return 40;
  }
  return (typeof process !== "undefined" && process.stdout?.rows) || 24;
}

// ─── process.exit stub ───────────────────────────────────────────────────────

/**
 * process.exit() replacement.
 * In the terminal this exits the process; in the browser it navigates to "/".
 */
export function exit(code?: number): never {
  if (isWeb) {
    if (typeof window !== "undefined") {
      window.location.href = "/";
    }
    // Keep the never return type satisfied in TS
    throw new Error(`exit(${code ?? 0})`);
  }
  process.exit(code ?? 0);
}

// ─── stdin/stdout stubs ───────────────────────────────────────────────────────

/** No-op write stub for web environments. */
export function writeStdout(data: string): boolean {
  if (!isWeb) {
    return process.stdout.write(data);
  }
  // In browser, send to console so output isn't silently dropped
  console.log("[stdout]", data);
  return true;
}

// ─── useStdout / useTerminalSize stubs ────────────────────────────────────────

/**
 * Minimal useStdout-compatible object for web environments.
 * The real hook is from Ink and returns { stdout: NodeJS.WriteStream }.
 */
export const stdoutStub = {
  write: writeStdout,
  columns: getColumns(),
  rows: getRows(),
};

// ─── useInput stub ────────────────────────────────────────────────────────────

/**
 * No-op shim for Ink's useInput hook.
 * Components that use useInput for keyboard shortcuts should use native
 * keydown listeners in web mode instead.
 */
export function useInputStub(_handler: unknown, _options?: unknown): void {
  // Intentional no-op for web
}

// ─── useApp stub ─────────────────────────────────────────────────────────────

/**
 * Stub for Ink's useApp hook (provides exit()).
 */
export function useAppStub() {
  return { exit: () => exit(0) };
}
