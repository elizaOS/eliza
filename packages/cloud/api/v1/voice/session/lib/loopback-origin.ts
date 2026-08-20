/**
 * Validates the local voice runtime origin before any network request, keeping
 * loopback routing free of credentials and path, query, or fragment ambiguity.
 */

export class LocalRuntimeConversationFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalRuntimeConversationFetchError";
  }
}

export function resolveLoopbackOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    // error-policy:J2 Configuration errors retain their parse cause so the
    // local gateway fails at startup rather than hiding a broken route.
    throw new LocalRuntimeConversationFetchError(
      "local runtime origin is not a valid URL",
      { cause: error },
    );
  }

  const isLoopbackHost =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  const isBareOrigin =
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  if (!isHttp || !isLoopbackHost || !isBareOrigin) {
    throw new LocalRuntimeConversationFetchError(
      "local runtime origin must be a bare HTTP loopback origin",
    );
  }
  return url;
}
