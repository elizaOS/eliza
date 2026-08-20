/**
 * Byte budget for host-shell stdio. `runOnHost` concatenates every stdout and
 * stderr chunk for the lifetime of the child; a hostile command can emit
 * without bound during the 30s timeout and pin the agent. Audio redaction
 * already kills children at 1 MiB of stdio — shell exec did not.
 *
 * 8 MiB sits above an honest verbose `git diff` / test log and still fail-closes
 * a flood. An overflowing last chunk keeps its leading complete-code-point
 * prefix so the beginning of the output survives without corrupting UTF-8.
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
 * Append one decoded child-stdio chunk. When it crosses the byte ceiling, keep
 * the longest leading sequence of complete UTF-8 code points that fits.
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
      const encoded = Buffer.from(chunk, "utf8");
      let end = remaining;
      while (end > 0) {
        const nextByte = encoded[end];
        if (nextByte === undefined || (nextByte & 0xc0) !== 0x80) break;
        end -= 1;
      }
      const head = encoded.subarray(0, end).toString("utf8");
      state.bytes += end;
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
