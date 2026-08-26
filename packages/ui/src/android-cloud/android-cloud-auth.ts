/**
 * Native Android handoff for the canonical Eliza Cloud sign-in flow.
 *
 * The application keeps its normal first-run chat and full app shell; this
 * module contributes the PKCE protocol and Keystore-backed pending-login state
 * needed to use hosted authentication and safely resume through an Android
 * deep link. Play builds use a Custom Tab; pinned launcher builds navigate the
 * same first-party flow inside their own WebView task.
 */

import { registerPlugin } from "@capacitor/core";
import { isSafeNavigationUrl } from "../utils/navigation-url";
import {
  AndroidCloudAuthError,
  AndroidCloudClient,
  type AndroidCloudLoginAttempt,
  type AndroidCloudLoginCompletion,
  type AndroidCloudPendingLoginStore,
  parseAndroidCloudCallbackAttemptId,
} from "./android-cloud-client";

export const ANDROID_CLOUD_AUTH_RESULT_EVENT =
  "eliza:android-cloud-auth-result" as const;
export const ANDROID_CLOUD_AUTH_STARTED_EVENT =
  "eliza:android-cloud-auth-started" as const;
const ANDROID_CLOUD_LOGIN_HOSTS = new Set([
  "cloud.eliza.app",
  "cloud-staging.eliza.app",
]);

export interface AndroidCloudAuthResult {
  apiBase?: string;
  attemptId: string;
  ok: boolean;
  error?: string;
  retryable?: boolean;
}

interface SecureCredentialsPlugin {
  get(options: { slot: "pending_login" }): Promise<{ value: string | null }>;
  set(options: { slot: "pending_login"; value: string }): Promise<void>;
  remove(options: { slot: "pending_login" }): Promise<void>;
}

const SecureCredentials = registerPlugin<SecureCredentialsPlugin>(
  "ElizaSecureCredentials",
);

const pendingLoginStore: AndroidCloudPendingLoginStore = {
  async read() {
    return (await SecureCredentials.get({ slot: "pending_login" })).value;
  },
  async write(value) {
    await SecureCredentials.set({ slot: "pending_login", value });
  },
  async clear() {
    await SecureCredentials.remove({ slot: "pending_login" });
  },
};

function client(cloudApiBase?: string): AndroidCloudClient {
  return new AndroidCloudClient({
    cloudApiBase:
      cloudApiBase ?? import.meta.env.VITE_ELIZA_CLOUD_BASE ?? undefined,
    pendingLoginStore,
  });
}

const completionByAttempt = new Map<
  string,
  Promise<AndroidCloudLoginCompletion>
>();
const completedAttempts = new Map<string, AndroidCloudLoginCompletion>();
let latestCompletion: AndroidCloudLoginCompletion | null = null;

function rememberCompletion(completion: AndroidCloudLoginCompletion): void {
  completedAttempts.set(completion.state, completion);
  latestCompletion = completion;
  while (completedAttempts.size > 8) {
    const oldest = completedAttempts.keys().next().value;
    if (typeof oldest !== "string") break;
    completedAttempts.delete(oldest);
  }
}

function publishResult(result: AndroidCloudAuthResult): void {
  window.dispatchEvent(
    new CustomEvent<AndroidCloudAuthResult>(ANDROID_CLOUD_AUTH_RESULT_EVENT, {
      detail: result,
    }),
  );
}

/** Creates the hosted login URL while keeping the verifier in Android Keystore. */
export async function beginAndroidCloudSignIn(
  cloudApiBase?: string,
): Promise<AndroidCloudLoginAttempt> {
  return client(cloudApiBase).beginLogin();
}

/** Navigate the launcher WebView only to the canonical hosted login origins. */
export function navigateAndroidCloudSignInInApp(
  url: string,
  navigate: (safeUrl: string) => void = (safeUrl) =>
    window.location.assign(safeUrl),
): boolean {
  if (!isSafeNavigationUrl(url)) return false;
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    !ANDROID_CLOUD_LOGIN_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    return false;
  }
  navigate(parsed.toString());
  return true;
}

/**
 * Exchanges one OS-delivered callback and announces the result to the mounted
 * canonical shell. A handled failure is still terminal for this callback, so
 * the native replay buffer can acknowledge it instead of looping forever.
 */
export async function completeAndroidCloudSignIn(
  callbackUrl: string,
): Promise<AndroidCloudLoginCompletion> {
  const attemptId = parseAndroidCloudCallbackAttemptId(callbackUrl);
  if (attemptId) {
    window.dispatchEvent(
      new CustomEvent(ANDROID_CLOUD_AUTH_STARTED_EVENT, {
        detail: { attemptId },
      }),
    );
  }
  if (attemptId) {
    const completed = completedAttempts.get(attemptId);
    if (completed) return completed;
    const active = completionByAttempt.get(attemptId);
    if (active) return active;
  }

  const completion = (async () => {
    try {
      const result = await client().completeLogin(callbackUrl);
      rememberCompletion(result);
      window.dispatchEvent(new CustomEvent("steward-token-sync"));
      publishResult({
        apiBase: result.apiBase,
        attemptId: result.state,
        ok: true,
      });
      return result;
    } catch (error) {
      const resultAttemptId =
        error instanceof AndroidCloudAuthError ? error.attemptId : attemptId;
      if (error instanceof AndroidCloudAuthError && resultAttemptId) {
        publishResult({
          attemptId: resultAttemptId,
          error: error.message,
          ok: false,
          retryable: error.disposition === "retry",
        });
      }
      throw error;
    }
  })();
  if (attemptId) completionByAttempt.set(attemptId, completion);
  try {
    return await completion;
  } finally {
    if (attemptId && completionByAttempt.get(attemptId) === completion) {
      completionByAttempt.delete(attemptId);
    }
  }
}

/** Clears an abandoned verifier when the hosted browser cannot be opened. */
export async function cancelAndroidCloudSignIn(
  attemptId: string,
): Promise<boolean> {
  return client().cancelLogin(attemptId);
}

/** Returns a cold callback completion that arrived before React subscribed. */
export function takeLatestAndroidCloudCompletion(): AndroidCloudLoginCompletion | null {
  const completion = latestCompletion;
  latestCompletion = null;
  return completion;
}

/** Distinguishes a fully activated stored session from an exchange still replaying. */
export async function hasPendingAndroidCloudSignIn(): Promise<boolean> {
  return Boolean((await pendingLoginStore.read())?.trim());
}
