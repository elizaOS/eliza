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
 * Append one child-stdio chunk. `chunk` must already be a decoded string
 * (the caller puts the stream in "utf8" mode via `setEncoding`) so a
 * multi-byte code point split across two OS pipe chunks is reassembled by
 * Node's StringDecoder before it ever reaches here, instead of each half
 * being decoded independently and replaced with U+FFFD. When the write
 * would exceed `maxBytes`, keep the leading slice that fills the cap
 * exactly, then return `overflow`.
 */
export function appendShellStdio(
  state: ShellStdioState,
  target: "stdout" | "stderr",
  chunk: string,
  maxBytes = MAX_SHELL_STDIO_BYTES,
): "ok" | "overflow" {
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  const remaining = maxBytes - state.bytes;
  if (chunkBytes > remaining) {
    if (remaining > 0) {
      const head = Buffer.from(chunk, "utf8")
        .subarray(0, remaining)
        .toString("utf8");
      state.bytes += remaining;
      if (target === "stdout") {
        state.stdout += head;
      } else {
        state.stderr += head;
      }
    }
    return "overflow";
  }
  state.bytes += chunkBytes;
  if (target === "stdout") {
    state.stdout += chunk;
  } else {
    state.stderr += chunk;
  }
  return "ok";
}
