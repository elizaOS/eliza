/**
 * Native iOS sign-in for Eliza Cloud (#16420).
 *
 * Runs the same server-registered mobile PKCE protocol as Android
 * (`/api/v1/app-auth/mobile/{config,token,ack}`), but the hosted login is
 * presented by `ASWebAuthenticationSession` with a claimed HTTPS callback
 * (`https://eliza.app/auth/callback`). The session returns the callback
 * in-process, so the PKCE verifier never leaves this renderer's memory and no
 * deep link has to be replayed. The activated credential is persisted through
 * the Steward token store, which the storage bridge backs with the Apple
 * Keychain (`@elizaos/capacitor-secure-store`, `session.steward_token`), and
 * is written before the server ACK so it stays inactive until acknowledged.
 *
 * One browser session owns a sign-in at a time, and a callback code is
 * exchanged exactly once: a failed exchange is never retried with the same
 * (consumed) code.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  AndroidCloudClient,
  type AndroidCloudLoginCompletion,
  type AndroidCloudPendingLoginStore,
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
    const client = new AndroidCloudClient({
      cloudApiBase,
      deviceName: "iOS",
      pendingLoginStore: memoryPendingLoginStore(),
    });
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

/** Dismisses a presented sign-in sheet, if any. */
export async function cancelIosCloudSignIn(): Promise<void> {
  if (!Capacitor.isPluginAvailable("ElizaCloudAuthSession")) return;
  await CloudAuthSession.cancel();
}
