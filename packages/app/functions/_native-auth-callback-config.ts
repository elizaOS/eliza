import type { BrowserSignInConfiguration } from "./_browser-sign-in";

const ASSETS_PREFIX = "/assets/";
const OIDC_PROTOCOL_PATHS = new Set([
  "/.well-known/openid-configuration",
  "/.well-known/oidc/jwks.json",
  // Android App Link verification fetches this from the link host itself and
  // does not follow redirects, so it must be proxied here (never the SPA's
  // index.html, which would fail verification with a 200 text/html body).
  "/.well-known/assetlinks.json",
]);
export function isProtocolPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/steward" ||
    pathname.startsWith("/steward/") ||
    OIDC_PROTOCOL_PATHS.has(pathname)
  );
}

export interface NativeAuthCallback {
  redirectUri: string;
  androidPackage: string;
  appName: string;
  browserSignIn?: BrowserSignInConfiguration;
}

export class NativeAuthCallbackConfigurationError extends Error {
  override readonly name = "NativeAuthCallbackConfigurationError";
  constructor() {
    super("Invalid native auth callback configuration");
  }
}

const NATIVE_AUTH_CALLBACK_SUFFIX = "/auth/callback";
const NATIVE_BILLING_RETURN_SUFFIX = "/billing/return";

/**
 * The checkout return of a configured native app: its sign-in callback path
 * with `/auth/callback` replaced by `/billing/return`. Cloud derives the same
 * address for a mobile checkout (`mobileBillingReturnUrl`); a callback with
 * another shape has no billing return.
 */
export function nativeBillingReturnPath(redirectUri: string): string | null {
  const pathname = new URL(redirectUri).pathname;
  return pathname.endsWith(NATIVE_AUTH_CALLBACK_SUFFIX)
    ? `${pathname.slice(0, -NATIVE_AUTH_CALLBACK_SUFFIX.length)}${NATIVE_BILLING_RETURN_SUFFIX}`
    : null;
}

/** Request data selects a configured callback; it cannot define a destination. */
export function selectNativeAuthCallback(
  raw: unknown,
  url: URL,
  kind: "callback" | "browser-start" | "billing-return" = "callback",
): NativeAuthCallback | null {
  if (raw === undefined || raw === "") return null;
  let entries: unknown;
  try {
    entries = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    // error-policy:J3 Invalid operator configuration cannot define a return route.
    throw new NativeAuthCallbackConfigurationError();
  }
  if (!Array.isArray(entries)) throw new NativeAuthCallbackConfigurationError();
  const routes = new Set<string>();
  const storageKeys = new Set<string>();
  let selected: NativeAuthCallback | null = null;
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "redirectUri",
            "androidPackage",
            "appName",
            "browserSignIn",
          ].includes(key),
      ) ||
      typeof entry.redirectUri !== "string" ||
      typeof entry.androidPackage !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(
        entry.androidPackage,
      ) ||
      typeof entry.appName !== "string" ||
      !entry.appName.trim()
    ) {
      throw new NativeAuthCallbackConfigurationError();
    }
    let callback: URL;
    try {
      callback = new URL(entry.redirectUri);
    } catch {
      // error-policy:J3 Do not reflect malformed operator input in the response.
      throw new NativeAuthCallbackConfigurationError();
    }
    if (
      callback.protocol !== "https:" ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      callback.href !== entry.redirectUri ||
      /[%;*\\]/.test(callback.pathname) ||
      isProtocolPath(callback.pathname) ||
      callback.pathname.startsWith(ASSETS_PREFIX) ||
      routes.has(callback.href)
    ) {
      throw new NativeAuthCallbackConfigurationError();
    }
    routes.add(callback.href);
    if (entry.browserSignIn !== undefined) {
      const configuration = entry.browserSignIn;
      if (
        !configuration ||
        typeof configuration !== "object" ||
        Array.isArray(configuration) ||
        Object.keys(configuration).some(
          (key) =>
            ![
              "startPath",
              "returnPath",
              "storageKey",
              "apiOrigin",
              "tenant",
            ].includes(key),
        ) ||
        typeof configuration.storageKey !== "string" ||
        !/^[A-Za-z0-9:._-]{1,128}$/.test(configuration.storageKey) ||
        typeof configuration.tenant !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(configuration.tenant)
      )
        throw new NativeAuthCallbackConfigurationError();
      for (const key of ["startPath", "returnPath"] as const) {
        const value = configuration[key];
        if (
          typeof value !== "string" ||
          !/^\/[A-Za-z0-9/_~.-]+$/.test(value) ||
          value.startsWith("//") ||
          new URL(value, callback.origin).pathname !== value ||
          isProtocolPath(value) ||
          value.startsWith(ASSETS_PREFIX)
        )
          throw new NativeAuthCallbackConfigurationError();
      }
      let api: URL;
      try {
        api = new URL(configuration.apiOrigin);
      } catch {
        // error-policy:J3 Invalid operator input cannot define an auth authority.
        throw new NativeAuthCallbackConfigurationError();
      }
      const start = callback.origin + configuration.startPath;
      const storageKey = `${callback.origin}:${configuration.storageKey}`;
      if (
        api.protocol !== "https:" ||
        api.username ||
        api.password ||
        api.origin !== configuration.apiOrigin ||
        routes.has(start) ||
        storageKeys.has(storageKey)
      )
        throw new NativeAuthCallbackConfigurationError();
      routes.add(start);
      storageKeys.add(storageKey);
    }
    const billingReturnPath = nativeBillingReturnPath(entry.redirectUri);
    if (billingReturnPath !== null) {
      // The derived return is a served route too; it may not shadow a configured one.
      const billingReturn = callback.origin + billingReturnPath;
      if (routes.has(billingReturn))
        throw new NativeAuthCallbackConfigurationError();
      routes.add(billingReturn);
    }
    if (
      url.protocol === "https:" &&
      url.origin === callback.origin &&
      url.pathname ===
        (kind === "callback"
          ? callback.pathname
          : kind === "billing-return"
            ? billingReturnPath
            : entry.browserSignIn?.startPath)
    )
      selected = entry;
  }
  return selected;
}
