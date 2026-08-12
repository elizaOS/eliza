/**
 * Canonical Google connector OAuth callback resolution. Chat, Settings, and the
 * connector-account provider must agree on `GOOGLE_REDIRECT_URI` for
 * `/api/connectors/google/oauth/callback`; portless loopback origins are
 * rejected because they cannot reach the served local API port.
 */
import type { IAgentRuntime } from "@elizaos/core";

export const GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH = "/api/connectors/google/oauth/callback";

export type GoogleOAuthCallbackConfigIssueCode =
  | "missing"
  | "malformed"
  | "portless_loopback"
  | "wrong_path";

export interface GoogleOAuthCallbackConfigIssue {
  code: GoogleOAuthCallbackConfigIssueCode;
  message: string;
}

export interface GoogleOAuthCallbackConfigAssessment {
  configured: boolean;
  redirectUri: string | null;
  issues: GoogleOAuthCallbackConfigIssue[];
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
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
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

export function assessGoogleOAuthCallbackConfig(
  runtime: RuntimeWithSettings
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

export function resolveGoogleConnectorOAuthCallbackUrl(runtime: RuntimeWithSettings): string {
  const assessment = assessGoogleOAuthCallbackConfig(runtime);
  if (!assessment.configured || !assessment.redirectUri) {
    const detail = assessment.issues.map((issue) => issue.message).join(" ");
    throw new Error(
      detail ||
        "Google OAuth requires GOOGLE_REDIRECT_URI to be configured for /api/connectors/google/oauth/callback."
    );
  }
  return assessment.redirectUri;
}
