/**
 * Canonical Google connector OAuth callback resolution. Chat, Settings, and the
 * connector-account provider must agree on `GOOGLE_REDIRECT_URI` for
 * `/api/connectors/google/oauth/callback`. Validation fails closed: only
 * http/https callbacks are accepted (plain http only on loopback), URLs
 * carrying credentials, a query, or a fragment are rejected, portless loopback
 * origins are rejected because they cannot reach the served local API port,
 * and — when the caller knows the origin actually serving the connector API —
 * a callback targeting a different host or port is rejected as unreachable.
 */
import type { IAgentRuntime } from "@elizaos/core";

export const GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH = "/api/connectors/google/oauth/callback";

export type GoogleOAuthCallbackConfigIssueCode =
  | "missing"
  | "malformed"
  | "wrong_scheme"
  | "credentials"
  | "query"
  | "fragment"
  | "portless_loopback"
  | "wrong_path"
  | "wrong_host"
  | "wrong_port";

export interface GoogleOAuthCallbackConfigIssue {
  code: GoogleOAuthCallbackConfigIssueCode;
  message: string;
}

export interface GoogleOAuthCallbackConfigAssessment {
  configured: boolean;
  redirectUri: string | null;
  issues: GoogleOAuthCallbackConfigIssue[];
}

export interface GoogleOAuthCallbackConfigOptions {
  /**
   * Origin actually serving the connector API, typically the URL of the
   * request being handled. When provided, the callback must target the same
   * host (loopback names are one equivalence class) and, when the served
   * origin names an explicit port, the same port. The served scheme is never
   * compared: request URLs are built from the Host header behind an http base,
   * so a TLS-terminating proxy would make scheme comparison lie.
   */
  servedOrigin?: URL | string;
}

type RuntimeWithSettings = Pick<IAgentRuntime, "getSetting">;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRedirectUriSetting(runtime: RuntimeWithSettings): string | undefined {
  return nonEmptyString(runtime.getSetting?.("GOOGLE_REDIRECT_URI"));
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  // Loopback IPv4 must be a genuinely numeric dotted quad in 127.0.0.0/8: a DNS
  // name like 127.0.0.1.attacker.example is an external host, never loopback.
  // The URL parser already canonicalizes IPv4 shorthand (127.1 → 127.0.0.1).
  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

/**
 * Loopback callbacks must name an explicit port (for example `31437`). A
 * portless `http://127.0.0.1/...` origin targets implicit port 80, not the
 * served local API.
 */
export function isPortlessLoopbackRedirectUrl(url: URL): boolean {
  if (!isLoopbackHost(url.hostname)) return false;
  return url.port === "";
}

/** URL.port with scheme-default ports ("80" for http, "443" for https) normalized to "". */
function explicitPort(url: URL): string {
  if (url.protocol === "http:" && url.port === "80") return "";
  if (url.protocol === "https:" && url.port === "443") return "";
  return url.port;
}

export function assessGoogleOAuthCallbackConfig(
  runtime: RuntimeWithSettings,
  options?: GoogleOAuthCallbackConfigOptions
): GoogleOAuthCallbackConfigAssessment {
  const raw = readRedirectUriSetting(runtime);
  if (!raw) {
    return {
      configured: false,
      redirectUri: null,
      issues: [
        {
          code: "missing",
          message:
            "GOOGLE_REDIRECT_URI is not configured. Set it to the served connector callback, for example http://127.0.0.1:31437/api/connectors/google/oauth/callback.",
        },
      ],
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      configured: false,
      redirectUri: null,
      issues: [
        {
          code: "malformed",
          message: "GOOGLE_REDIRECT_URI is not a valid URL.",
        },
      ],
    };
  }

  const issues: GoogleOAuthCallbackConfigIssue[] = [];
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    issues.push({
      code: "wrong_scheme",
      message: `GOOGLE_REDIRECT_URI must use http or https, not ${parsed.protocol.replace(/:$/, "")}.`,
    });
  } else if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    issues.push({
      code: "wrong_scheme",
      message: "GOOGLE_REDIRECT_URI may use plain http only for loopback callbacks; use https.",
    });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    issues.push({
      code: "credentials",
      message: "GOOGLE_REDIRECT_URI must not embed credentials.",
    });
  }
  if (parsed.search !== "") {
    issues.push({
      code: "query",
      message: "GOOGLE_REDIRECT_URI must not carry a query string.",
    });
  }
  if (parsed.hash !== "") {
    issues.push({
      code: "fragment",
      message: "GOOGLE_REDIRECT_URI must not carry a fragment.",
    });
  }
  const normalizedPath =
    parsed.pathname.endsWith("/") && parsed.pathname.length > 1
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
  if (normalizedPath !== GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH) {
    issues.push({
      code: "wrong_path",
      message: `GOOGLE_REDIRECT_URI must end with ${GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH}.`,
    });
  }
  if (isPortlessLoopbackRedirectUrl(parsed)) {
    issues.push({
      code: "portless_loopback",
      message:
        "GOOGLE_REDIRECT_URI uses a portless loopback origin. Include the served API port, for example http://127.0.0.1:31437/api/connectors/google/oauth/callback.",
    });
  }

  if (options?.servedOrigin !== undefined) {
    const served =
      options.servedOrigin instanceof URL ? options.servedOrigin : new URL(options.servedOrigin);
    const sameHost = isLoopbackHost(parsed.hostname)
      ? isLoopbackHost(served.hostname)
      : parsed.hostname.toLowerCase() === served.hostname.toLowerCase();
    if (!sameHost) {
      issues.push({
        code: "wrong_host",
        message: `GOOGLE_REDIRECT_URI targets ${parsed.hostname}, but the connector API is served on ${served.hostname}.`,
      });
    } else {
      // Assert the port only when the served origin names one explicitly. A
      // portless served origin (default-port deployment behind a proxy) tells
      // us nothing to fail closed on; portless loopback callbacks are already
      // rejected above.
      const servedPort = explicitPort(served);
      if (servedPort !== "" && explicitPort(parsed) !== servedPort) {
        issues.push({
          code: "wrong_port",
          message: `GOOGLE_REDIRECT_URI targets port ${explicitPort(parsed) || "(default)"}, but the connector API is served on port ${servedPort}.`,
        });
      }
    }
  }

  if (issues.length > 0) {
    return {
      configured: false,
      redirectUri: parsed.toString(),
      issues,
    };
  }

  return {
    configured: true,
    redirectUri: parsed.toString(),
    issues: [],
  };
}

export function resolveGoogleConnectorOAuthCallbackUrl(
  runtime: RuntimeWithSettings,
  options?: GoogleOAuthCallbackConfigOptions
): string {
  const assessment = assessGoogleOAuthCallbackConfig(runtime, options);
  if (!assessment.configured || !assessment.redirectUri) {
    const detail = assessment.issues.map((issue) => issue.message).join(" ");
    throw new Error(
      detail ||
        "Google OAuth requires GOOGLE_REDIRECT_URI to be configured for /api/connectors/google/oauth/callback."
    );
  }
  return assessment.redirectUri;
}
