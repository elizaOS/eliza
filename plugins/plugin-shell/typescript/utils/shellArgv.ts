/**
 * Shell argument parsing utilities.
 *
 * Provides functions to split shell command strings into argument arrays,
 * handling quotes and escape sequences.
 *
 * @module utils/shellArgv
 */

/**
 * Split a shell command string into an array of arguments.
 *
 * Handles:
 * - Single quotes (literal strings)
 * - Double quotes (literal strings)
 * - Backslash escapes (outside quotes)
 * - Whitespace as argument separator
 *
 * @param raw - The raw command string
 * @returns Array of arguments, or null if string has unclosed quotes/escapes
 *
 * @example
 * ```ts
 * splitShellArgs('git commit -m "fix bug"')
 * // => ['git', 'commit', '-m', 'fix bug']
 *
 * splitShellArgs("echo 'hello world'")
 * // => ['echo', 'hello world']
 *
 * splitShellArgs('path\\ with\\ spaces')
 * // => ['path with spaces']
 *
 * splitShellArgs('"unclosed')
 * // => null (unclosed quote)
 * ```
 */
export function splitShellArgs(raw: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushToken = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  pushToken();
  return tokens;
}
