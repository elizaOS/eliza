/**
 * Byte budget for host-shell stdio. `runOnHost` concatenates every stdout and
 * stderr chunk for the lifetime of the child; a hostile command can emit
 * without bound during the 30s timeout and pin the agent. Audio redaction
 * already kills children at 1 MiB of stdio — shell exec did not.
 */

/** Combined stdout+stderr ceiling for one host `runShell` child. */
export const MAX_SHELL_STDIO_BYTES = 1_048_576;

export type ShellStdioState = {
  stdout: string;
  stderr: string;
  bytes: number;
};

export function createShellStdioState(): ShellStdioState {
  return { stdout: "", stderr: "", bytes: 0 };
}

/**
 * Append one child-stdio chunk. Returns `overflow` without mutating the
 * accumulated strings when the next write would exceed `maxBytes`.
 */
export function appendShellStdio(
  state: ShellStdioState,
  target: "stdout" | "stderr",
  chunk: Buffer,
  maxBytes = MAX_SHELL_STDIO_BYTES,
): "ok" | "overflow" {
  if (state.bytes + chunk.byteLength > maxBytes) {
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
