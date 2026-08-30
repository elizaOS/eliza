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
import { type IAgentRuntime, isLoopbackBindHost } from "@elizaos/core";

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
  | "served_origin_malformed"
  | "wrong_host"
  | "wrong_port";

export interface GoogleOAuthCallbackConfigIssue {
  code: GoogleOAuthCallbackConfigIssueCode;
  message: string;
}

export interface GoogleOAuthCallbackConfigAssessment {
  configured: boolean;
  /** Present only when the callback passed every validation check. */
  redirectUri: string | null;
  issues: GoogleOAuthCallbackConfigIssue[];
}

export interface GoogleOAuthCallbackConfigOptions {
  /**
   * Origin actually serving the connector API, typically the URL of the
   * request being handled. When provided, the callback must target the same
   * concrete host, scheme, and effective port. Distinct loopback addresses are
   * not assumed to share a listener. Proxied HTTP routes use the configured
   * external base as their authority.
   */
  servedOrigin?: URL | string;
}

type RuntimeWithSettings = Pick<IAgentRuntime, "getSetting">;

const FALLBACK_CALLBACK_EXAMPLE = "http://127.0.0.1:31437/api/connectors/google/oauth/callback";

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRedirectUriSetting(runtime: RuntimeWithSettings): string | undefined {
  return nonEmptyString(runtime.getSetting?.("GOOGLE_REDIRECT_URI"));
}

function normalizedHostname(url: URL): string {
  return url.hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function servedCallbackExample(options?: GoogleOAuthCallbackConfigOptions): string {
  if (options?.servedOrigin === undefined) return FALLBACK_CALLBACK_EXAMPLE;
  try {
    const served =
      options.servedOrigin instanceof URL ? options.servedOrigin : new URL(options.servedOrigin);
    if (
      (served.protocol !== "http:" && served.protocol !== "https:") ||
      served.username !== "" ||
      served.password !== ""
    ) {
      return FALLBACK_CALLBACK_EXAMPLE;
    }
    return `${served.origin}${GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH}`;
  } catch {
    // error-policy:J3 An unparsable served origin is untrusted input; the
    // documented fallback example is an explicit placeholder, not a claim
    // about the real callback URL.
    return FALLBACK_CALLBACK_EXAMPLE;
  }
}

/**
 * Loopback callbacks must name an explicit port (for example `31437`). A
 * portless `http://127.0.0.1/...` origin targets implicit port 80, not the
 * served local API.
 */
export function isPortlessLoopbackRedirectUrl(url: URL): boolean {
  if (!isLoopbackBindHost(url.hostname)) return false;
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
  const callbackExample = servedCallbackExample(options);
  if (!raw) {
    return {
      configured: false,
      redirectUri: null,
      issues: [
        {
          code: "missing",
          message: `GOOGLE_REDIRECT_URI is not configured. Set it to the served connector callback: ${callbackExample}.`,
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
  } else if (parsed.protocol === "http:" && !isLoopbackBindHost(parsed.hostname)) {
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
  if (parsed.href.includes("?")) {
    issues.push({
      code: "query",
      message: "GOOGLE_REDIRECT_URI must not carry a query string.",
    });
  }
  if (parsed.href.includes("#")) {
    issues.push({
      code: "fragment",
      message: "GOOGLE_REDIRECT_URI must not carry a fragment.",
    });
  }
  if (parsed.pathname !== GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH) {
    issues.push({
      code: "wrong_path",
      message: `GOOGLE_REDIRECT_URI path must equal ${GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH}.`,
    });
  }
  if (isPortlessLoopbackRedirectUrl(parsed)) {
    issues.push({
      code: "portless_loopback",
      message: `GOOGLE_REDIRECT_URI uses a portless loopback origin. Include the served API port: ${callbackExample}.`,
    });
  }

  if (options?.servedOrigin !== undefined) {
    let served: URL;
    try {
      served =
        options.servedOrigin instanceof URL ? options.servedOrigin : new URL(options.servedOrigin);
    } catch {
      issues.push({
        code: "served_origin_malformed",
        message: "The configured external connector origin is not a valid URL.",
      });
      return { configured: false, redirectUri: null, issues };
    }
    if (
      (served.protocol !== "http:" && served.protocol !== "https:") ||
      served.username !== "" ||
      served.password !== ""
    ) {
      issues.push({
        code: "served_origin_malformed",
        message: "The configured external connector origin must be an http or https origin.",
      });
      return { configured: false, redirectUri: null, issues };
    }
    if (parsed.protocol !== served.protocol) {
      issues.push({
        code: "wrong_scheme",
        message: `GOOGLE_REDIRECT_URI uses ${parsed.protocol.replace(/:$/, "")}, but the connector API is served over ${served.protocol.replace(/:$/, "")}.`,
      });
    }
    const sameHost = normalizedHostname(parsed) === normalizedHostname(served);
    if (!sameHost) {
      issues.push({
        code: "wrong_host",
        message: `GOOGLE_REDIRECT_URI targets ${parsed.hostname}, but the connector API is served on ${served.hostname}.`,
      });
    } else {
      const servedPort = explicitPort(served);
      if (explicitPort(parsed) !== servedPort) {
        const callbackPort = explicitPort(parsed) || (parsed.protocol === "https:" ? "443" : "80");
        const connectorPort = servedPort || (served.protocol === "https:" ? "443" : "80");
        issues.push({
          code: "wrong_port",
          message: `GOOGLE_REDIRECT_URI targets port ${callbackPort}, but the connector API is served on port ${connectorPort}.`,
        });
      }
    }
  }

  if (issues.length > 0) {
    return {
      configured: false,
      redirectUri: null,
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
