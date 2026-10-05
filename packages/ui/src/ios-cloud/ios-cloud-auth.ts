/**
 * Native iOS sign-in for Eliza Cloud (#16420).
 *
 * Runs the same server-registered mobile PKCE protocol as Android
 * (`/api/v1/app-auth/mobile/{config,token,ack}`), but the hosted login is
 * presented by `ASWebAuthenticationSession` with a claimed HTTPS callback
 * (`https://eliza.app/auth/callback`). The session returns the callback
 * in-process, so the PKCE verifier never leaves this renderer's memory and no
 * deep link has to be replayed. The activated credential is persisted through
 * Apple Keychain in two phases: the exchanged secret is staged in its own
 * Keychain slot (`session.cloud_mobile_pending`) before the server ACK and is
 * promoted into the Steward token store (`session.steward_token`, also
 * Keychain-backed through the storage bridge) only after the ACK, so an
 * unacknowledged secret never becomes the renderer's session. A staged
 * credential left by an interrupted launch is promoted only if its ACK was
 * recorded; otherwise it is revoked before discard because a lost ACK can
 * leave the server active. Sign-out revokes both active and staged mobile
 * credentials before removing their local copies.
 *
 * One browser session owns a sign-in at a time, and a callback code is
 * exchanged exactly once: a failed exchange is never retried with the same
 * (consumed) code.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import { readStoredStewardToken } from "@elizaos/plugin-elizacloud/steward-session-client";
import {
  AndroidCloudClient,
  type AndroidCloudLoginCompletion,
  type AndroidCloudPendingLoginStore,
  type AndroidCloudStagedCredentialRecovery,
} from "../android-cloud/android-cloud-client";

/** Native plugin compiled into the iOS App target (ElizaCloudAuthSessionPlugin.swift). */
interface ElizaCloudAuthSessionPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  start(options: {
    url: string;
    ephemeral?: boolean;
  }): Promise<{ callbackUrl: string }>;
  cancel(): Promise<void>;
}

const CloudAuthSession = registerPlugin<ElizaCloudAuthSessionPlugin>(
  "ElizaCloudAuthSession",
);

export type IosCloudAuthErrorCode =
  | "cancelled"
  | "unavailable"
  | "busy"
  | "failed";

/** Typed failure so callers can tell a user cancel from a broken handoff. */
export class IosCloudAuthError extends Error {
  readonly code: IosCloudAuthErrorCode;

  constructor(
    code: IosCloudAuthErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "IosCloudAuthError";
    this.code = code;
  }
}

function nativeErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function toIosCloudAuthError(error: unknown): IosCloudAuthError {
  if (error instanceof IosCloudAuthError) return error;
  const code = nativeErrorCode(error);
  if (code === "cancelled") {
    return new IosCloudAuthError(
      "cancelled",
      "Eliza Cloud sign-in was cancelled.",
      {
        cause: error,
      },
    );
  }
  if (code === "unavailable") {
    return new IosCloudAuthError(
      "unavailable",
      "Native Eliza Cloud sign-in is unavailable on this device.",
      { cause: error },
    );
  }
  if (code === "busy") {
    return new IosCloudAuthError(
      "busy",
      "An Eliza Cloud sign-in is already open.",
      { cause: error },
    );
  }
  return new IosCloudAuthError(
    "failed",
    error instanceof Error && error.message
      ? error.message
      : "Eliza Cloud sign-in could not be completed.",
    { cause: error },
  );
}

/** In-memory pending login: the callback returns to this same process. */
function memoryPendingLoginStore(): AndroidCloudPendingLoginStore {
  let value: string | null = null;
  return {
    async read() {
      return value;
    },
    async write(next) {
      value = next;
    },
    async clear() {
      value = null;
    },
  };
}

const IOS_CLOUD_STAGED_CREDENTIAL_KEY = "session.cloud_mobile_pending" as const;
/** Mobile credentials minted by `/api/v1/app-auth/mobile/token`. */
const MOBILE_CREDENTIAL_RE = /^eliza_mobile_[0-9a-f]{64}$/;

function loadSecureStore() {
  return import("@elizaos/capacitor-secure-store");
}

/**
 * Keychain slot holding an exchanged credential until its ACK is recorded.
 * Every failure is explicit: a Keychain that cannot be read or written must
 * never read as "no staged credential".
 */
export const iosCloudCredentialStagingStore: AndroidCloudPendingLoginStore = {
  async read() {
    const { ElizaSecureStore } = await loadSecureStore();
    const result = await ElizaSecureStore.get({
      key: IOS_CLOUD_STAGED_CREDENTIAL_KEY,
    });
    if (result.ok) {
      return typeof result.value === "string" ? result.value : null;
    }
    if (result.error === "not_found") return null;
    throw new IosCloudAuthError(
      "failed",
      result.message ?? "The Keychain could not be read.",
    );
  },
  async write(value) {
    const { ElizaSecureStore } = await loadSecureStore();
    const result = await ElizaSecureStore.set({
      key: IOS_CLOUD_STAGED_CREDENTIAL_KEY,
      value,
    });
    if (!result.ok) {
      throw new IosCloudAuthError(
        "failed",
        result.message ?? "The Keychain could not store the Cloud session.",
      );
    }
  },
  async clear() {
    const { ElizaSecureStore } = await loadSecureStore();
    const result = await ElizaSecureStore.remove({
      key: IOS_CLOUD_STAGED_CREDENTIAL_KEY,
    });
    if (!result.ok) {
      throw new IosCloudAuthError(
        "failed",
        result.message ?? "The Keychain could not remove the Cloud session.",
      );
    }
  },
};

function iosCloudClient(cloudApiBase: string | undefined): AndroidCloudClient {
  return new AndroidCloudClient({
    cloudApiBase,
    deviceName: "iOS",
    credentialStagingStore: iosCloudCredentialStagingStore,
    pendingLoginStore: memoryPendingLoginStore(),
  });
}

/**
 * Reconciles a Keychain-staged credential left by an interrupted sign-in:
 * promotes a recorded ACK, otherwise revokes the ambiguous credential before
 * discarding it without replacing the active session.
 */
export async function recoverIosCloudCredential(
  cloudApiBase?: string,
): Promise<AndroidCloudStagedCredentialRecovery> {
  const outcome = await iosCloudClient(cloudApiBase).recoverStagedCredential();
  if (outcome === "activated") {
    window.dispatchEvent(new CustomEvent("steward-token-sync"));
  }
  return outcome;
}

/** True when the active session is a native mobile credential (not a Steward JWT). */
export function hasIosNativeCloudCredential(): boolean {
  const token = readStoredStewardToken()?.trim();
  return Boolean(token && MOBILE_CREDENTIAL_RE.test(token));
}

/** Revokes staged native credentials before a different active session signs out. */
export async function revokeIosCloudStagedCredential(
  cloudApiBase?: string,
): Promise<void> {
  await iosCloudClient(cloudApiBase).revokeStagedCredential();
}

/**
 * Revokes active and staged mobile credentials before removing
 * their Keychain copies. Refused revocations preserve credentials for retry.
 */
export async function signOutIosCloud(cloudApiBase?: string): Promise<void> {
  await iosCloudClient(cloudApiBase).signOut();
}

/** True on iOS builds whose App target registers the native session plugin (iOS 17.4+). */
export async function isIosNativeCloudAuthAvailable(): Promise<boolean> {
  if (Capacitor.getPlatform() !== "ios" || !Capacitor.isNativePlatform()) {
    return false;
  }
  if (!Capacitor.isPluginAvailable("ElizaCloudAuthSession")) return false;
  const { available } = await CloudAuthSession.isAvailable();
  return available === true;
}

/**
 * Maps the claimed HTTPS callback the session returned onto the canonical app
 * callback grammar (`elizaos://auth/callback?...`) the mobile PKCE client
 * validates, after checking the exact origin and path. Query validation
 * (allowed keys, single values, state match) stays in the shared client.
 */
export function canonicalAppCallback(callbackUrl: string): string {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch (error) {
    throw new IosCloudAuthError(
      "failed",
      "Eliza Cloud returned an invalid callback.",
      { cause: error },
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "eliza.app" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/auth/callback"
  ) {
    throw new IosCloudAuthError(
      "failed",
      "Eliza Cloud returned an untrusted callback.",
    );
  }
  return `elizaos://auth/callback${url.search}`;
}

let inFlight: Promise<AndroidCloudLoginCompletion> | null = null;

/**
 * Presents hosted Eliza Cloud sign-in in an ASWebAuthenticationSession and
 * activates the resulting mobile credential. Concurrent calls join the one
 * in-flight sign-in instead of opening a second browser.
 */
export function signInWithIosCloud(
  cloudApiBase: string | undefined,
  options: { switchAccount?: boolean } = {},
): Promise<AndroidCloudLoginCompletion> {
  if (inFlight) return inFlight;
  const attempt = (async () => {
    const client = iosCloudClient(cloudApiBase);
    // A staged credential from an interrupted launch must be reconciled before
    // a new exchange can reuse the single staging slot.
    if ((await client.recoverStagedCredential()) === "activated") {
      // An already-acknowledged credential is this device's session; do not
      // open a second browser sign-in over it.
      window.dispatchEvent(new CustomEvent("steward-token-sync"));
      return {
        apiBase: client.apiBase,
        pendingCleanupRequired: false,
        state: "recovered",
      };
    }
    const login = await client.beginLogin({
      switchAccount: options.switchAccount === true,
    });
    let callbackUrl: string;
    try {
      ({ callbackUrl } = await CloudAuthSession.start({
        url: login.browserUrl,
        // An explicit account switch must not silently reuse the browser's
        // existing hosted session.
        ephemeral: options.switchAccount === true,
      }));
    } catch (error) {
      await client.cancelLogin(login.state);
      throw toIosCloudAuthError(error);
    }
    // The authorization code is single-use: exchange it exactly once and
    // surface any failure instead of replaying a consumed code.
    const completion = await client.completeLogin(
      canonicalAppCallback(callbackUrl),
    );
    window.dispatchEvent(new CustomEvent("steward-token-sync"));
    return completion;
  })();
  inFlight = attempt;
  const release = () => {
    if (inFlight === attempt) inFlight = null;
  };
  attempt.then(release, release);
  return attempt;
}
