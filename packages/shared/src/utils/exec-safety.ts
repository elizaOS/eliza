/**
 * Guards config values that may be executed as commands, rejecting shell
 * metacharacters and validating bare-name/path-with-args shapes. Used by the zod
 * config schemas to keep injected/executable strings from smuggling shell syntax.
 */
const UNSAFE_CHARS = /[\0\r\n;&|`$<>"']/;
const BARE_NAME = /^[A-Za-z0-9._+-]+$/;

function hasPathArguments(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    if (value[index]?.trim() !== "") {
      index += 1;
      continue;
    }

    while (index < value.length && value[index]?.trim() === "") index += 1;
    const tokenStart = index;
    while (index < value.length && value[index]?.trim() !== "") index += 1;
    if (tokenStart === index) return false;

    const token = value.slice(tokenStart, index);
    if (token.startsWith("-") || BARE_NAME.test(token)) return true;
  }
  return false;
}

function isLikelyPath(value: string): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

export function isSafeExecutableValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (UNSAFE_CHARS.test(value)) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (hasPathArguments(trimmed)) return false;
  if (trimmed.startsWith("-")) return false;
  if (isLikelyPath(trimmed)) return true;
  return BARE_NAME.test(trimmed);
}
