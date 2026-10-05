/**
 * Defines the shared completeness and text-integrity contract for captured
 * terminal output at both the HTTP route and action consumer boundaries.
 */

export const MAX_TERMINAL_CAPTURE_BYTES = 4 * 1024 * 1024;

function terminalTextIsWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasUnsafeTerminalCodePoint(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      // Shell/provider adapters expose strings, so the boundary cannot
      // distinguish a literal replacement character from lossy UTF-8 decode.
      // Reject it conservatively rather than certify possibly invalid bytes.
      codePoint === 0xfffd ||
      (codePoint < 0x20 && ![0x09, 0x0a, 0x0d, 0x1b].includes(codePoint)) ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

export function capturedTerminalOutputIsSafe(
  stdout: string,
  stderr: string,
): boolean {
  return (
    terminalTextIsWellFormed(stdout) &&
    terminalTextIsWellFormed(stderr) &&
    !hasUnsafeTerminalCodePoint(stdout) &&
    !hasUnsafeTerminalCodePoint(stderr) &&
    Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") <=
      MAX_TERMINAL_CAPTURE_BYTES
  );
}

/** Safe pre-dispatch failures. Messages never contain submitted commands or credentials. */
export const TERMINAL_REJECTIONS = {
  TERMINAL_COMMAND_REQUIRED: {
    status: 400,
    message: "A non-empty shell command is required.",
    retryable: true,
  },
  TERMINAL_COMMAND_TOO_LONG: {
    status: 400,
    message:
      "Command exceeds maximum length (4096 characters). Use the coding tools for longer scripts.",
    retryable: true,
  },
  TERMINAL_COMMAND_SINGLE_LINE_REQUIRED: {
    status: 400,
    message:
      "Command must be a single line without literal newline, carriage return or NUL characters. Use escaped newlines inside a single-line command, or the coding tools for scripts.",
    retryable: true,
  },
  TERMINAL_AUTHORIZATION_REQUIRED: {
    status: 403,
    message:
      "Terminal authorization is required. Ask the owner to authorize terminal access; do not bypass this restriction.",
    retryable: false,
  },
  TERMINAL_SHELL_DISABLED: {
    status: 403,
    message:
      "Shell execution is disabled by host policy. Do not bypass this restriction.",
    retryable: false,
  },
} as const;
export type TerminalRejectionCode = keyof typeof TERMINAL_REJECTIONS;

export function terminalRejectionResponse(code: TerminalRejectionCode) {
  const definition = TERMINAL_REJECTIONS[code];
  return {
    error: definition.message,
    code,
    acceptance: "rejected" as const,
    executionStatus: "not_started" as const,
    retryable: definition.retryable,
  };
}
