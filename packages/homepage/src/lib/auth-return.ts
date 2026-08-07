const RETURN_TO_STORAGE_KEY = "eliza_auth_return_to";

export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value?.startsWith("/") || value.startsWith("//")) return null;

  try {
    const url = new URL(value, "https://eliza.app");
    return url.origin === "https://eliza.app"
      ? `${url.pathname}${url.search}${url.hash}`
      : null;
  } catch {
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
