const UNSAFE_CHARS = /[\0\r\n;&|`$<>"']/;
const BARE_NAME = /^[A-Za-z0-9._+-]+$/;
const PATH_WITH_ARGS = /\s+(?:-{1,2}\S+|[A-Za-z0-9._+-]+)(?:\s|$)/;

function isLikelyPath(value: string): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

export function isSafeExecutableValue(
  value: string | null | undefined,
): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  if (UNSAFE_CHARS.test(trimmed)) return false;
  if (PATH_WITH_ARGS.test(trimmed)) return false;
  if (isLikelyPath(trimmed)) return true;
  if (trimmed.startsWith("-")) return false;
  return BARE_NAME.test(trimmed);
}
