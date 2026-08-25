/**
 * Preserves an internal post-authentication destination across redirects and
 * rejects any destination that can escape the homepage origin.
 */

const RETURN_TO_STORAGE_KEY = "eliza_auth_return_to";

export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value?.startsWith("/") || value.startsWith("//")) return null;

  try {
    const url = new URL(value, "https://eliza.app");
    if (url.origin !== "https://eliza.app") return null;
    const dest = `${url.pathname}${url.search}${url.hash}`;
    // Dot-segment inputs like "/..//host" pass the raw "//" guard but normalize
    // to a protocol-relative path that escapes the origin; reject the result too.
    return dest.startsWith("//") ? null : dest;
  } catch {
    // error-policy:J3 Malformed navigation input is an explicit invalid value.
    return null;
  }
}

export function rememberReturnTo(value: string | null): void {
  if (typeof window === "undefined") return;
  const safeValue = safeReturnTo(value);
  if (safeValue) {
    sessionStorage.setItem(RETURN_TO_STORAGE_KEY, safeValue);
  } else {
    sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
  }
}

export function peekReturnTo(
  queryValue: string | null,
  fallback = "/connected",
): string {
  const queryReturn = safeReturnTo(queryValue);
  if (queryReturn) return queryReturn;
  if (typeof window === "undefined") return fallback;
  return (
    safeReturnTo(sessionStorage.getItem(RETURN_TO_STORAGE_KEY)) ?? fallback
  );
}

export function clearRememberedReturnTo(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
}
