/**
 * Byte budget for host-shell stdio. `runOnHost` concatenates every stdout and
 * stderr chunk for the lifetime of the child; a hostile command can emit
 * without bound during the 30s timeout and pin the agent. Audio redaction
 * already kills children at 1 MiB of stdio — shell exec did not.
 *
 * 8 MiB sits above an honest verbose `git diff` / test log and still fail-closes
 * a flood. An overflowing last chunk keeps its leading slice so the beginning
 * of the output survives (pipe chunks are typically ≤64 KiB).
 */

/** Combined stdout+stderr ceiling for one host `runShell` child. */
export const MAX_SHELL_STDIO_BYTES = 8_388_608;

export type ShellStdioState = {
  stdout: string;
  stderr: string;
  bytes: number;
};

export function createShellStdioState(): ShellStdioState {
  return { stdout: "", stderr: "", bytes: 0 };
}

/**
 * Append one child-stdio chunk. When the write would exceed `maxBytes`, keep
 * the leading slice that fills the cap exactly, then return `overflow`.
 */
export function appendShellStdio(
  state: ShellStdioState,
  target: "stdout" | "stderr",
  chunk: Buffer,
  maxBytes = MAX_SHELL_STDIO_BYTES,
): "ok" | "overflow" {
  const remaining = maxBytes - state.bytes;
  if (chunk.byteLength > remaining) {
    if (remaining > 0) {
      const head = chunk.subarray(0, remaining);
      state.bytes += head.byteLength;
      const text = head.toString("utf8");
      if (target === "stdout") {
        state.stdout += text;
      } else {
        state.stderr += text;
      }
    }
    return "overflow";
  }
  state.bytes += chunk.byteLength;
  const text = chunk.toString("utf8");
  if (target === "stdout") {
    state.stdout += text;
  } else {
    state.stderr += text;
  }
  return "ok";
}
