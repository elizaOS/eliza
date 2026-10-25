/**
 * Reduces Android Cloud-onboarding traffic to privacy-safe device evidence.
 * Raw browser handoffs contain PKCE bindings and runtime routes contain user
 * identifiers, so callers receive only validated protocol facts and phase
 * names that are safe to persist in CI artifacts.
 */
import path from "node:path";

const CLOUD_LOGIN_URL =
  /https:\/\/cloud(?:-staging)?\.eliza\.app\/login\?[^\s"'<>]+/gi;
const CLOUD_LOGIN_HOSTS = new Set([
  "cloud.eliza.app",
  "cloud-staging.eliza.app",
]);
const CLOUD_RESPONSE_HOST =
  /^(?:api(?:-staging)?|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cloud(?:-staging)?)\.eliza\.app$/i;
const MOBILE_CLIENT_ID = "ai.elizaos.app";
const MOBILE_REDIRECT_URI = "https://eliza.app/auth/callback";
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_STATE = /^[A-Za-z0-9_-]{43,128}$/;
const ANDROID_EMULATOR_SERIAL = /^emulator(?:-|$)/i;
const ANDROID_CLOUD_BOOTSTRAP_QUERY = "__eliza_cloud_bootstrap";
const ANDROID_CLOUD_ACCOUNT_SWITCH_KEY =
  "eliza:android-cloud:account-switch-pending:v1";
const ANDROID_CLOUD_RESET_KEYS = [
  "eliza:first-run",
  "eliza:first-run-complete",
  "eliza:onboarding-complete",
  "eliza:setup:step",
  "eliza:ui-shell-mode",
  "eliza:mobile-runtime-mode",
  "eliza:enable-runtime-chooser",
  "eliza:first-run:cloud-resume",
  "elizaos:first-run:force-fresh",
  "elizaos:active-server",
  "steward_session_token",
  "eliza:android-cloud:pending-login:v1",
  ANDROID_CLOUD_ACCOUNT_SWITCH_KEY,
  "eliza:e2e-wallet:autologin",
  "eliza:e2e-wallet:pk",
] as const;

export interface AndroidCloudPkceHandoffEvidence {
  authorizePath: "/app-auth/authorize";
  browserHost: "cloud.eliza.app" | "cloud-staging.eliza.app";
  codeChallengeShapeValid: true;
  clientId: typeof MOBILE_CLIENT_ID;
  codeChallengeMethod: "S256";
  deviceName: "Android";
  environment: "production" | "staging";
  redirectUri: typeof MOBILE_REDIRECT_URI;
  stateShapeValid: true;
  switchAccount: boolean;
}

export type AndroidCloudResponsePhase =
  | "mobile-config"
  | "mobile-token"
  | "mobile-ack"
  | "personal-agent"
  | "message-stream";

export interface AndroidCloudResponseEvidence {
  method: "GET" | "POST";
  phase: AndroidCloudResponsePhase;
  status: number;
}

export interface AndroidTapPoint {
  x: number;
  y: number;
}

export interface AndroidPhysicalDeviceReceipt {
  deviceClass: "physical";
  emulatorSerialPattern: false;
  kernelQemuTruthy: false;
}

export interface AndroidCloudOnboardingBootstrapPlan {
  navigationPath: string;
  queryKey: typeof ANDROID_CLOUD_BOOTSTRAP_QUERY;
  resetKeys: readonly string[];
  seedEntries: readonly (readonly [string, string])[];
  token: string;
}

interface AndroidCloudOnboardingBootstrapRuntime {
  href: string;
  replaceUrl(value: string): void;
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem">;
}

function androidSystemPropertyIsTruthy(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    !new Set(["0", "false", "no", "off"]).has(normalized)
  );
}

/** Reject emulator identity without retaining a device serial or fingerprint. */
export function requirePhysicalAndroidDevice(
  serial: string,
  kernelQemuProperty: string,
): AndroidPhysicalDeviceReceipt {
  if (ANDROID_EMULATOR_SERIAL.test(serial.trim())) {
    throw new Error(
      "Android Cloud onboarding requires a physical device; an emulator-style ADB serial was detected.",
    );
  }
  if (androidSystemPropertyIsTruthy(kernelQemuProperty)) {
    throw new Error(
      "Android Cloud onboarding requires a physical device; ro.kernel.qemu reports an emulator.",
    );
  }
  return {
    deviceClass: "physical",
    emulatorSerialPattern: false,
    kernelQemuTruthy: false,
  };
}

/**
 * Build a one-navigation storage reset. The token is removed from the URL at
 * document start, so init scripts retained by a serial Playwright page cannot
 * erase the mobile credential on the later post-login reload.
 */
export function buildAndroidCloudOnboardingBootstrapPlan(
  token: string,
  options: { switchAccount?: boolean } = {},
): AndroidCloudOnboardingBootstrapPlan {
  if (!/^[a-f0-9]{32}$/.test(token)) {
    throw new Error(
      "Android Cloud bootstrap token must be 128-bit lowercase hex.",
    );
  }
  const query = new URLSearchParams({
    [ANDROID_CLOUD_BOOTSTRAP_QUERY]: token,
  });
  return {
    navigationPath: `/?${query.toString()}`,
    queryKey: ANDROID_CLOUD_BOOTSTRAP_QUERY,
    resetKeys: ANDROID_CLOUD_RESET_KEYS,
    seedEntries: options.switchAccount
      ? [[ANDROID_CLOUD_ACCOUNT_SWITCH_KEY, "1"]]
      : [],
    token,
  };
}

/**
 * Apply the exact reset contract at document start, before the shell installs
 * the surface-realm guard. This function is passed directly to
 * `page.addInitScript`, and is also executable with an injected runtime in unit
 * tests; it deliberately has no module-scope dependencies.
 */
export function applyAndroidCloudOnboardingDocumentBootstrap(
  plan: AndroidCloudOnboardingBootstrapPlan,
  injectedRuntime?: AndroidCloudOnboardingBootstrapRuntime,
): boolean {
  const runtime =
    injectedRuntime ??
    ({
      href: window.location.href,
      replaceUrl: (value: string) =>
        window.history.replaceState(null, "", value),
      storage: window.localStorage,
    } satisfies AndroidCloudOnboardingBootstrapRuntime);
  const url = new URL(runtime.href);
  const tokens = url.searchParams.getAll(plan.queryKey);
  if (tokens.length !== 1 || tokens[0] !== plan.token) return false;

  for (const key of plan.resetKeys) runtime.storage.removeItem(key);
  for (const [key, value] of plan.seedEntries) {
    runtime.storage.setItem(key, value);
  }
  url.searchParams.delete(plan.queryKey);
  runtime.replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  return true;
}

function singleValue(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key);
  return values.length === 1 ? values[0] : null;
}

function hasOnlyKeys(url: URL, keys: ReadonlySet<string>): boolean {
  return [...url.searchParams.keys()].every((key) => keys.has(key));
}

function xmlAttribute(node: string, name: string): string | null {
  return node.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1] ?? null;
}

/** Find the Google control without returning the surrounding account hierarchy. */
export function findAndroidGoogleProviderTapPoint(
  hierarchy: string,
): AndroidTapPoint | null {
  for (const match of hierarchy.matchAll(/<node\b[^>]*>/gi)) {
    const node = match[0];
    const contentDescription = xmlAttribute(node, "content-desc")?.trim();
    const text = xmlAttribute(node, "text")?.trim();
    const label = contentDescription || text || "";
    if (!/^(?:continue with )?google$/i.test(label.trim())) continue;
    if (xmlAttribute(node, "clickable")?.toLowerCase() !== "true") continue;
    if (xmlAttribute(node, "enabled")?.toLowerCase() === "false") continue;
    const bounds = xmlAttribute(node, "bounds")?.match(
      /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/,
    );
    if (!bounds) continue;
    const left = Number(bounds[1]);
    const top = Number(bounds[2]);
    const right = Number(bounds[3]);
    const bottom = Number(bounds[4]);
    if (right <= left || bottom <= top) continue;
    return {
      x: Math.floor((left + right) / 2),
      y: Math.floor((top + bottom) / 2),
    };
  }
  return null;
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
    // error-policy:J3 A malformed candidate is an explicit untrusted URL.
    return false;
  }
}

/**
 * Validate a browser launch found in logcat without returning its state,
 * challenge, returnTo value, or complete URL.
 */
export function extractAndroidCloudPkceHandoffEvidence(
  logcat: string,
): AndroidCloudPkceHandoffEvidence | null {
  const normalized = logcat.replaceAll("\\/", "/");
  for (const match of normalized.matchAll(CLOUD_LOGIN_URL)) {
    let login: URL;
    try {
      login = new URL(match[0].replace(/[),;}\]]+$/, ""));
    } catch {
      // error-policy:J3 Ignore malformed logcat candidates and keep scanning.
      continue;
    }
    const browserHost = login.hostname.toLowerCase();
    if (
      login.protocol !== "https:" ||
      !CLOUD_LOGIN_HOSTS.has(browserHost) ||
      login.pathname !== "/login" ||
      login.username ||
      login.password ||
      login.port ||
      login.hash ||
      !hasOnlyKeys(login, new Set(["returnTo", "switchAccount"]))
    ) {
      continue;
    }
    const switchAccountValues = login.searchParams.getAll("switchAccount");
    if (
      switchAccountValues.length > 1 ||
      (switchAccountValues.length === 1 && switchAccountValues[0] !== "1")
    ) {
      continue;
    }
    const returnTo = singleValue(login, "returnTo");
    if (!returnTo) continue;

    let authorize: URL;
    try {
      authorize = new URL(returnTo, login.origin);
    } catch {
      // error-policy:J3 An invalid nested return target is not a valid handoff.
      continue;
    }
    const authorizeKeys = new Set([
      "flow",
      "client_id",
      "environment",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
      "device_name",
    ]);
    if (
      authorize.origin !== login.origin ||
      authorize.pathname !== "/app-auth/authorize" ||
      authorize.hash ||
      !hasOnlyKeys(authorize, authorizeKeys) ||
      [...authorizeKeys].some(
        (key) => authorize.searchParams.getAll(key).length !== 1,
      )
    ) {
      continue;
    }

    const environment =
      browserHost === "cloud-staging.eliza.app" ? "staging" : "production";
    if (
      singleValue(authorize, "flow") !== "mobile_pkce" ||
      singleValue(authorize, "client_id") !== MOBILE_CLIENT_ID ||
      singleValue(authorize, "environment") !== environment ||
      singleValue(authorize, "redirect_uri") !== MOBILE_REDIRECT_URI ||
      singleValue(authorize, "code_challenge_method") !== "S256" ||
      singleValue(authorize, "device_name") !== "Android" ||
      !PKCE_STATE.test(singleValue(authorize, "state") ?? "") ||
      !PKCE_CHALLENGE.test(singleValue(authorize, "code_challenge") ?? "")
    ) {
      continue;
    }

    return {
      authorizePath: "/app-auth/authorize",
      browserHost:
        browserHost as AndroidCloudPkceHandoffEvidence["browserHost"],
      codeChallengeShapeValid: true,
      clientId: MOBILE_CLIENT_ID,
      codeChallengeMethod: "S256",
      deviceName: "Android",
      environment,
      redirectUri: MOBILE_REDIRECT_URI,
      stateShapeValid: true,
      switchAccount: switchAccountValues.length === 1,
    };
  }
  return null;
}

/** Reduce one recognized Cloud response to a route- and identifier-free receipt. */
export function buildAndroidCloudResponseEvidence(
  value: string | URL,
  method: string,
  status: number,
): AndroidCloudResponseEvidence | null {
  if (!isTrustedAndroidCloudResponseUrl(value)) return null;
  const url = value instanceof URL ? value : new URL(value);
  const normalizedMethod = method.toUpperCase();
  let phase: AndroidCloudResponsePhase | null = null;
  if (
    normalizedMethod === "GET" &&
    url.pathname === "/api/v1/app-auth/mobile/config"
  ) {
    phase = "mobile-config";
  } else if (
    normalizedMethod === "POST" &&
    url.pathname === "/api/v1/app-auth/mobile/token"
  ) {
    phase = "mobile-token";
  } else if (
    normalizedMethod === "POST" &&
    url.pathname === "/api/v1/app-auth/mobile/ack"
  ) {
    phase = "mobile-ack";
  } else if (
    normalizedMethod === "GET" &&
    url.pathname === "/api/v1/eliza/personal"
  ) {
    phase = "personal-agent";
  } else if (
    normalizedMethod === "POST" &&
    /\/api\/conversations\/[^/]+\/messages\/stream$/.test(url.pathname)
  ) {
    phase = "message-stream";
  }
  if (!phase || !Number.isInteger(status) || status < 100 || status > 599) {
    return null;
  }
  return {
    method: normalizedMethod as AndroidCloudResponseEvidence["method"],
    phase,
    status,
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
