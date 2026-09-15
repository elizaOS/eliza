/**
 * Applies the shared credential-transport policy for LoginClient and LoginAuth.
 * Non-loopback endpoints require HTTPS unless the caller explicitly accepts an
 * insecure transport; embedded credentials, queries and fragments are rejected.
 */

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

/** Remove trailing URL separators in one bounded pass. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/**
 * Throws unless `baseUrl` is HTTPS or targets loopback. Operators on trusted
 * private networks may opt out explicitly with `allowInsecureBaseUrl`, which
 * still warns loudly at construction.
 */
export function assertSecureBaseUrl(
  baseUrl: string,
  allowInsecureBaseUrl?: boolean,
): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl must be a valid absolute URL");
  }
  if (url.username || url.password)
    throw new Error("baseUrl must not embed credentials");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use HTTP(S)");
  }
  if (url.search || url.hash) {
    throw new Error("baseUrl must not contain a query or fragment");
  }
  if (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    return;
  }
  if (allowInsecureBaseUrl) {
    console.warn(
      `[steward-sdk] WARNING: baseUrl '${url.origin}' is not HTTPS; credentials travel in ` +
        "cleartext. Use allowInsecureBaseUrl only on trusted private networks.",
    );
    return;
  }
  throw new Error(
    "baseUrl must use HTTPS unless it targets loopback (http://localhost, http://127.0.0.1, " +
      "http://[::1]). Set allowInsecureBaseUrl: true to override on trusted private networks.",
  );
}
