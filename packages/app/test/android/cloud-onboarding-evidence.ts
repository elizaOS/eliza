/**
 * Defines the inline Android Cloud-onboarding stills required by the device
 * evidence contract. The Playwright capture and attachment metadata share one
 * descriptor so a filename or MIME-type edit cannot silently produce PNGs.
 */
import path from "node:path";

const CLOUD_LOGIN_SESSION_ID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CLOUD_LOGIN_URL = new RegExp(
  `https://(cloud(?:-staging)?\\.eliza\\.app)/auth/cli-login\\?session=(${CLOUD_LOGIN_SESSION_ID})`,
  "i",
);
const CLOUD_RESPONSE_HOST =
  /^(?:api(?:-staging)?|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cloud(?:-staging)?)\.eliza\.app$/i;

export interface AndroidCloudLoginHandoff {
  browserUrl: string;
  sessionId: string;
  apiBase: string;
}

/** Accept response evidence only from the control plane or managed runtime. */
export function isTrustedAndroidCloudResponseUrl(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      CLOUD_RESPONSE_HOST.test(url.hostname)
    );
  } catch {
    return false;
  }
}

/** Extract the real browser handoff without accepting unrelated logcat URLs. */
export function extractAndroidCloudLoginHandoff(
  logcat: string,
): AndroidCloudLoginHandoff | null {
  const normalized = logcat.replaceAll("\\/", "/");
  const match = normalized.match(CLOUD_LOGIN_URL);
  if (!match) return null;
  const [, appHost, sessionId] = match;
  const apiHost =
    appHost.toLowerCase() === "cloud-staging.eliza.app"
      ? "api-staging.eliza.app"
      : "api.eliza.app";
  return {
    browserUrl: match[0],
    sessionId,
    apiBase: `https://${apiHost}`,
  };
}

/** Build the authenticated server-side approval used by the device login poll. */
export function buildAndroidCloudLoginCompletionRequest(
  handoff: AndroidCloudLoginHandoff,
  authToken: string | undefined,
) {
  const token = authToken?.trim();
  if (!token) {
    throw new Error(
      "ELIZA_CLOUD_AUTH_TOKEN is required for the positive Android Cloud onboarding lane",
    );
  }
  return {
    url: `${handoff.apiBase}/api/auth/cli-session/${encodeURIComponent(handoff.sessionId)}/complete`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    } satisfies RequestInit,
  };
}

export const ANDROID_CLOUD_ONBOARDING_STILL_NAMES = [
  "sign-in-greeting",
  "home-landing",
  "reply-liveness",
] as const;

export type AndroidCloudOnboardingStillName =
  (typeof ANDROID_CLOUD_ONBOARDING_STILL_NAMES)[number];

export function buildAndroidCloudOnboardingJpegArtifact(
  artifactDir: string,
  name: AndroidCloudOnboardingStillName,
) {
  const artifactPath = path.join(artifactDir, `${name}.jpg`);
  return {
    screenshot: {
      path: artifactPath,
      fullPage: true,
      type: "jpeg" as const,
    },
    attachment: {
      path: artifactPath,
      contentType: "image/jpeg" as const,
    },
  };
}
