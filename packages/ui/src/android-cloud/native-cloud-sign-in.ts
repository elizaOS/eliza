/**
 * Eliza's Android host for the shared native Eliza Cloud sign-in client.
 *
 * The Android app signs in on its own screens: an email code, an SMS code or
 * Android's native Google account picker, through `ElizaCloudSignInPlugin`
 * (packages/app/platforms/android, a subclass of packages/auth/android's
 * `CloudSignInPlugin`). This module is the renderer half: the plugin as a
 * `NativeCloudSignInPort`, the deployment it signs in to, and a one-at-a-time
 * request broker that lets `useCloudState` ask for a sign-in and wait while
 * `AndroidNativeCloudSignInView` collects it. Every answer is parsed with
 * `@elizaos/auth/auth/native-cloud-sign-in` before it is trusted.
 *
 * No secret crosses the bridge. The native host writes the minted key to the
 * secure store's `session.steward_token`, the protected slot the storage bridge
 * already serves as the renderer's Cloud session; activation re-reads it from
 * there. The hosted Custom Tab / WebView PKCE sign-in this replaces is retired.
 */

import { registerPlugin } from "@capacitor/core";
import {
  type NativeCloudSignInAuthenticated,
  type NativeCloudSignInCopy,
  NativeCloudSignInError,
  type NativeCloudSignInPort,
  nativeCloudSignInFailureMessage,
  nativeSignInAuthenticated,
} from "@elizaos/auth/auth/native-cloud-sign-in";
import {
  DEFAULT_DIRECT_CLOUD_API_BASE_URL,
  resolveCanonicalDirectCloudApiBase,
  STAGING_DIRECT_CLOUD_API_BASE_URL,
} from "@elizaos/plugin-browser/remote-control/cloud-endpoints";
import {
  dispatchStewardSessionChange,
  STEWARD_TOKEN_KEY,
} from "@elizaos/plugin-elizacloud/steward-session-client";
import { getStorageValue } from "../bridge/storage-bridge";

/** The deployments `ElizaCloudSignInPlugin` admits (staging only in development builds). */
export type ElizaCloudEnvironment = "production" | "staging";
export type ElizaNativeCloudSignInPort =
  NativeCloudSignInPort<ElizaCloudEnvironment>;

/** The Capacitor name `ElizaCloudSignInPlugin` declares. */
export const ELIZA_NATIVE_CLOUD_SIGN_IN_PLUGIN = "ElizaCloudSignIn";

export const ELIZA_NATIVE_CLOUD_SIGN_IN_COPY: NativeCloudSignInCopy = {
  serviceName: "Eliza Cloud",
  productName: "Eliza",
};

// Held in an object, never returned from an async function: a Capacitor plugin
// proxy is thenable, so resolving a promise with it never settles.
let registeredPort: { port: ElizaNativeCloudSignInPort } | null = null;
let testPort: ElizaNativeCloudSignInPort | null = null;

/** The native plugin as a port. Answers are untrusted until parsed. */
export function androidNativeCloudSignInPort(): ElizaNativeCloudSignInPort {
  if (testPort) return testPort;
  registeredPort ??= {
    port: registerPlugin<ElizaNativeCloudSignInPort>(
      ELIZA_NATIVE_CLOUD_SIGN_IN_PLUGIN,
    ),
  };
  return registeredPort.port;
}

/** Test seam: replaces the native plugin with a mocked port (null restores it). */
export function setAndroidNativeCloudSignInPortForTesting(
  port: ElizaNativeCloudSignInPort | null,
): void {
  testPort = port;
}

/** The deployment this renderer's Cloud base belongs to. */
export function androidNativeCloudEnvironment(
  cloudApiBase: string | null | undefined,
): ElizaCloudEnvironment {
  return resolveCanonicalDirectCloudApiBase(cloudApiBase) ===
    STAGING_DIRECT_CLOUD_API_BASE_URL
    ? "staging"
    : "production";
}

/** The canonical Cloud API the minted key is used with. */
export function androidNativeCloudApiBase(
  environment: ElizaCloudEnvironment,
): string {
  return environment === "staging"
    ? STAGING_DIRECT_CLOUD_API_BASE_URL
    : DEFAULT_DIRECT_CLOUD_API_BASE_URL;
}

/** Owner-facing copy for any sign-in failure; never server text, codes or addresses. */
export function androidNativeCloudSignInMessage(error: unknown): string {
  return nativeCloudSignInFailureMessage(
    NativeCloudSignInError.from(error).code,
    ELIZA_NATIVE_CLOUD_SIGN_IN_COPY,
  );
}

/**
 * The message a failed sign-in leaves on the sign-in surface: the owner-facing
 * copy for a native failure code, or the verification error's own message.
 */
export function androidNativeCloudLoginErrorMessage(error: unknown): string {
  if (error instanceof NativeCloudSignInError)
    return androidNativeCloudSignInMessage(error);
  return error instanceof Error && error.message
    ? error.message
    : androidNativeCloudSignInMessage(error);
}

// ── Request broker: one sign-in at a time ──────────────────────────────────

export interface AndroidNativeCloudSignInRequest {
  readonly id: number;
  readonly environment: ElizaCloudEnvironment;
  readonly port?: ElizaNativeCloudSignInPort;
  readonly copy?: NativeCloudSignInCopy;
}

interface PendingRequest {
  request: AndroidNativeCloudSignInRequest;
  promise: Promise<NativeCloudSignInAuthenticated<ElizaCloudEnvironment>>;
  resolve: (
    outcome: NativeCloudSignInAuthenticated<ElizaCloudEnvironment>,
  ) => void;
  reject: (error: NativeCloudSignInError) => void;
  activate?: (
    signal: AbortSignal,
    outcome: NativeCloudSignInAuthenticated<ElizaCloudEnvironment>,
  ) => Promise<void>;
  returned?: NativeCloudSignInAuthenticated<ElizaCloudEnvironment>;
  onReturn?: (
    outcome: NativeCloudSignInAuthenticated<ElizaCloudEnvironment>,
  ) => void;
}

let nextRequestId = 1;
let pending: PendingRequest | null = null;
const requestListeners = new Set<() => void>();

function publishRequest(): void {
  for (const listener of requestListeners) listener();
}

/** Subscribes to the open request (for `useSyncExternalStore`). */
export function subscribeAndroidNativeCloudSignInRequest(
  listener: () => void,
): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

/** The sign-in the view should collect, or null. */
export function getAndroidNativeCloudSignInRequest(): AndroidNativeCloudSignInRequest | null {
  return pending?.request ?? null;
}

/**
 * Opens the native sign-in screens and settles when the owner signs in or
 * leaves. A second caller for the same deployment joins the open request; a
 * request for another deployment is refused as `login-active`.
 */
export function requestAndroidNativeCloudSignIn(
  environment: ElizaCloudEnvironment,
  activate?: (
    signal: AbortSignal,
    outcome: NativeCloudSignInAuthenticated<ElizaCloudEnvironment>,
  ) => Promise<void>,
  host?: { port: ElizaNativeCloudSignInPort; copy: NativeCloudSignInCopy },
): Promise<NativeCloudSignInAuthenticated<ElizaCloudEnvironment>> {
  if (pending) {
    return pending.request.environment === environment &&
      pending.request.port === host?.port
      ? pending.promise
      : Promise.reject(new NativeCloudSignInError("login-active"));
  }
  let resolve!: PendingRequest["resolve"];
  let reject!: PendingRequest["reject"];
  const promise = new Promise<
    NativeCloudSignInAuthenticated<ElizaCloudEnvironment>
  >((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  pending = {
    request: { id: nextRequestId++, environment, ...host },
    promise,
    resolve,
    reject,
    activate,
  };
  publishRequest();
  return promise;
}

/** The request's existing account owner verifies activation before the view closes. */
export async function activateAndroidNativeCloudSignIn(
  id: number,
  outcome: unknown,
  signal: AbortSignal,
): Promise<void> {
  const current = pending;
  if (!current || current.request.id !== id) return;
  signal.throwIfAborted();
  const parsed = nativeSignInAuthenticated(
    outcome,
    current.request.environment,
  );
  await current.activate?.(signal, parsed);
  signal.throwIfAborted();
  if (pending !== current)
    throw new DOMException("Sign-in owner changed", "AbortError");
  completeAndroidNativeCloudSignIn(id, parsed);
}

/** A retained completion can arrive before React mounts this request's view. */
export function subscribeAndroidNativeCloudSignInReturn(
  id: number,
  receive: (
    outcome: NativeCloudSignInAuthenticated<ElizaCloudEnvironment>,
  ) => void,
): () => void {
  const current = pending;
  if (!current || current.request.id !== id) return () => {};
  current.onReturn = receive;
  const returned = current.returned;
  current.returned = undefined;
  if (returned) receive(returned);
  return () => {
    if (current.onReturn === receive) current.onReturn = undefined;
  };
}

/** The view's answer: a parsed sign-in for exactly the requested deployment. */
export function completeAndroidNativeCloudSignIn(
  id: number,
  outcome: unknown,
): void {
  const current = pending;
  if (!current || current.request.id !== id) return;
  let parsed: NativeCloudSignInAuthenticated<ElizaCloudEnvironment>;
  try {
    parsed = nativeSignInAuthenticated(outcome, current.request.environment);
  } catch (error) {
    abandonAndroidNativeCloudSignIn(id, error);
    return;
  }
  pending = null;
  publishRequest();
  current.resolve(parsed);
}

/** The owner left or the sign-in cannot continue; the caller sees a stable code. */
export function abandonAndroidNativeCloudSignIn(
  id: number,
  error: unknown,
): void {
  const current = pending;
  if (!current || current.request.id !== id) return;
  pending = null;
  publishRequest();
  current.reject(NativeCloudSignInError.from(error));
}

// ── Session activation ─────────────────────────────────────────────────────

/**
 * Makes the key the native host stored the renderer's Cloud session: the
 * storage bridge re-reads the protected slot and the session change is
 * announced. A sign-in that left no key there is a storage failure.
 */
export async function activateAndroidNativeCloudSession(
  signal?: AbortSignal,
  outcome?: NativeCloudSignInAuthenticated<ElizaCloudEnvironment>,
  port: ElizaNativeCloudSignInPort = androidNativeCloudSignInPort(),
): Promise<void> {
  signal?.throwIfAborted();
  let token: string | null;
  try {
    token = await getStorageValue(STEWARD_TOKEN_KEY);
  } catch {
    // error-policy:J2 an unreadable protected store is the sign-in's storage failure.
    throw new NativeCloudSignInError("storage");
  }
  if (!token?.trim()) throw new NativeCloudSignInError("storage");
  signal?.throwIfAborted();
  if (outcome?.credentialId) {
    if (!port.credentialIdentity)
      throw new NativeCloudSignInError("unavailable");
    let value: unknown;
    try {
      value = await port.credentialIdentity({
        environment: outcome.environment,
      });
    } catch {
      throw new NativeCloudSignInError("storage");
    }
    signal?.throwIfAborted();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new NativeCloudSignInError("state-mismatch");
    const current = value as Record<string, unknown>;
    if (
      Object.keys(current).some(
        (key) => key !== "environment" && key !== "credentialId",
      ) ||
      current.environment !== outcome.environment ||
      current.credentialId !== outcome.credentialId
    )
      throw new NativeCloudSignInError("state-mismatch");
  }
  dispatchStewardSessionChange("present");
}

/**
 * A Google sign-in that completed natively after the app restarted (no
 * waiting call) is announced once; the handler receives only parsed outcomes.
 */
export async function listenForAndroidNativeCloudSignInCompleted(
  environment: ElizaCloudEnvironment,
  handler: (
    outcome: NativeCloudSignInAuthenticated<ElizaCloudEnvironment>,
  ) => void,
  port: ElizaNativeCloudSignInPort = androidNativeCloudSignInPort(),
): Promise<() => void> {
  if (!port.addListener) return () => {};
  const handle = await port.addListener("signInCompleted", (outcome) => {
    let parsed: NativeCloudSignInAuthenticated<ElizaCloudEnvironment>;
    try {
      parsed = nativeSignInAuthenticated(outcome, environment);
    } catch {
      // error-policy:J3 an answer for another deployment or with extra keys is ignored.
      return;
    }
    // A live request owns this return and its activation errors. Keep it until
    // its view subscribes; a startup listener must not race the interactive owner.
    if (
      pending?.request.environment === environment &&
      (pending.request.port ?? androidNativeCloudSignInPort()) === port
    ) {
      if (pending.onReturn) pending.onReturn(parsed);
      else pending.returned = parsed;
    } else handler(parsed);
  });
  return () => {
    void removeListenerHandle(handle);
  };
}

export async function removeListenerHandle(handle: unknown): Promise<void> {
  const remove =
    handle && typeof handle === "object"
      ? (handle as { remove?: unknown }).remove
      : undefined;
  if (typeof remove !== "function") return;
  try {
    await (remove as () => Promise<void>).call(handle);
  } catch {
    // error-policy:J4 a listener that is already gone needs no cleanup.
  }
}

/** After an explicit sign-out the next Google sign-in offers the account picker again. */
export async function clearAndroidNativeCloudCredentialState(
  port: ElizaNativeCloudSignInPort = androidNativeCloudSignInPort(),
): Promise<void> {
  try {
    await port.clearCredentialState?.();
  } catch {
    // error-policy:J4 best effort: the Cloud session is already signed out.
  }
}

/** Test-only: forget the open request without settling it. */
export function resetAndroidNativeCloudSignInForTesting(): void {
  pending = null;
  nextRequestId = 1;
  publishRequest();
}
