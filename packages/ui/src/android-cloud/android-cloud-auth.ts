/**
 * Android Cloud session helpers around the native sign-in.
 *
 * Sign-in itself is native (`./native-cloud-sign-in`: an email code, an SMS
 * code or Android's Google account picker through `ElizaCloudSignInPlugin`).
 * The hosted Custom Tab / in-app WebView PKCE handoff and its
 * `elizaos://auth/callback` completion are retired. What stays here: the
 * explicit account-switch marker, sign-out (revoking the exact mobile key
 * before removing it) and the one-time cleanup of a retired hosted sign-in's
 * pending verifier.
 */

import { registerPlugin } from "@capacitor/core";
import { logger } from "../logger.ts";
import { shellLocalStorage } from "../surface-realm-channel";
import {
  ANDROID_CLOUD_PENDING_LOGIN_KEY,
  AndroidCloudClient,
} from "./android-cloud-client";

const ANDROID_CLOUD_ACCOUNT_SWITCH_KEY =
  "eliza:android-cloud:account-switch-pending:v1";

interface SecureCredentialsPlugin {
  remove(options: { slot: "pending_login" }): Promise<void>;
}

// Held in an object: a Capacitor plugin proxy is thenable.
let secureCredentials: { plugin: SecureCredentialsPlugin } | null = null;
function retiredPendingLoginStore(): SecureCredentialsPlugin {
  secureCredentials ??= {
    plugin: registerPlugin<SecureCredentialsPlugin>("ElizaSecureCredentials"),
  };
  return secureCredentials.plugin;
}

function client(cloudApiBase?: string): AndroidCloudClient {
  return new AndroidCloudClient({
    cloudApiBase:
      cloudApiBase ?? import.meta.env.VITE_ELIZA_CLOUD_BASE ?? undefined,
  });
}

/** Persists explicit account-switch intent across renderer and app recreation. */
export function markAndroidCloudAccountSwitchPending(): void {
  shellLocalStorage.setItem(ANDROID_CLOUD_ACCOUNT_SWITCH_KEY, "1");
  if (window.localStorage.getItem(ANDROID_CLOUD_ACCOUNT_SWITCH_KEY) !== "1") {
    throw new Error("Eliza Cloud could not preserve the account switch.");
  }
}

/** True until a replacement mobile session is verified end to end. */
export function isAndroidCloudAccountSwitchPending(): boolean {
  return window.localStorage.getItem(ANDROID_CLOUD_ACCOUNT_SWITCH_KEY) === "1";
}

/** Removes the durable switch marker after replacement-session verification. */
export function clearAndroidCloudAccountSwitchPending(): void {
  shellLocalStorage.removeItem(ANDROID_CLOUD_ACCOUNT_SWITCH_KEY);
}

/** Revokes the exact mobile credential before removing its local copy. */
export async function signOutAndroidCloud(
  cloudApiBase?: string,
): Promise<void> {
  await client(cloudApiBase).signOut();
}

/**
 * Discards the PKCE verifier a retired hosted sign-in may have left (in the
 * Play build's Keystore slot and the renderer's legacy key). Nothing else is
 * touched: a saved Cloud session stays where it is and keeps working.
 * Idempotent; a store that is unavailable is left for the next start.
 */
export async function retireAndroidCloudHostedSignIn(): Promise<void> {
  try {
    shellLocalStorage.removeItem(ANDROID_CLOUD_PENDING_LOGIN_KEY);
  } catch (error) {
    // error-policy:J4 a stale non-secret key is retried on the next start.
    logger.warn({ error }, "[android-cloud] legacy pending-login key retained");
  }
  try {
    await retiredPendingLoginStore().remove({ slot: "pending_login" });
  } catch (error) {
    // error-policy:J4 builds without the Play Keystore slot have nothing to
    // remove; an unavailable store retries on the next start.
    logger.debug(
      { error },
      "[android-cloud] retired pending-login slot not cleared",
    );
  }
}
