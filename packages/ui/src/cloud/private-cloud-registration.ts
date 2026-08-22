/**
 * Route-owned private cloud surface registration (#18056).
 *
 * Public boot only registers public/auth routes. Private Cloud/settings
 * domains are loaded when a private path is actually visited, via
 * {@link ensurePrivateCloudSurfaces}. Status is observable so the shell can
 * show pending / retry / real-404 without fire-and-forget races.
 *
 * Snapshot identity is stable for `useSyncExternalStore` (one module-level
 * object replaced only on real state transitions). Completions are
 * generation-guarded so an obsolete failed attempt cannot overwrite a newer
 * successful one.
 */

import { registerMovedApplicationsCloudRoutes } from "./applications/register-moved-routes";

export type PrivateCloudRegistrationStatus =
  | "idle"
  | "pending"
  | "ready"
  | "error";

export interface PrivateCloudRegistrationSnapshot {
  status: PrivateCloudRegistrationStatus;
  error: Error | null;
}

const IDLE_SNAPSHOT: PrivateCloudRegistrationSnapshot = Object.freeze({
  status: "idle",
  error: null,
});

let privateRegistered = false;
let privateRegistration: Promise<void> | null = null;
/** Monotonic attempt id — only the latest attempt may commit terminal status. */
let loadGeneration = 0;
let snapshot: PrivateCloudRegistrationSnapshot = IDLE_SNAPSHOT;
const listeners = new Set<() => void>();

/** Production loader — overridable in tests via {@link setPrivateCloudLoadForTests}. */
let privateLoadImpl: () => Promise<void> = loadPrivateCloudDomains;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setSnapshot(
  next: PrivateCloudRegistrationStatus,
  error: Error | null = null,
): void {
  // Replace the module-level snapshot only when status/error actually change so
  // `useSyncExternalStore` sees a stable identity between store updates.
  if (snapshot.status === next && snapshot.error === error) {
    return;
  }
  snapshot = Object.freeze({ status: next, error });
  notify();
}

async function loadPrivateCloudDomains(): Promise<void> {
  // These lightweight redirect definitions have no domain import dependency.
  // Register them before the larger private chunk fan-out so route discovery
  // and direct legacy links do not temporarily observe them as missing.
  registerMovedApplicationsCloudRoutes();

  // Side-effecting domain modules: importing them runs their top-level
  // `registerCloudRoute(...)` calls.
  await Promise.all([
    import("./instances"),
    import("./analytics"),
    import("./home/routes"),
    import("./billing/routes"),
    import("./api-keys/routes"),
    import("./account-security/routes"),
    import("./monetization/routes"),
    import("./connectors/routes"),
    import("./organization/routes"),
  ]);

  const [
    { registerAdminCloudRoutes },
    { registerApiExplorerCloudRoute },
    { registerApprovalsCloudRoute },
    { registerMcpsCloudRoute },
    { registerCloudSettingsSections },
  ] = await Promise.all([
    import("./admin"),
    import("./api-explorer"),
    import("./approvals"),
    import("./mcps"),
    import("./settings"),
  ]);

  registerApiExplorerCloudRoute();
  registerApprovalsCloudRoute();

  registerAdminCloudRoutes();
  registerMcpsCloudRoute();
  registerCloudSettingsSections();
  const { registerManagedCloudAppShellPage } = await import(
    "./register-managed-cloud-page"
  );
  registerManagedCloudAppShellPage();
}

/**
 * Snapshot for `useSyncExternalStore`. Returns the same object reference until
 * the store mutates (React requires referential stability).
 */
export function getPrivateCloudRegistrationSnapshot(): PrivateCloudRegistrationSnapshot {
  return snapshot;
}

/** Subscribe to private-registration status changes. */
export function subscribePrivateCloudRegistration(
  onStoreChange: () => void,
): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/**
 * True when the URL requires private Cloud domains. Retired dashboard links
 * are included so the router can load before issuing their canonical redirect.
 * Public auth and marketing paths stay false so idle `/login` never starts
 * private chunk downloads.
 */
export function pathNeedsPrivateCloudSurfaces(pathname: string): boolean {
  const path = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return (
    path === "cloud" ||
    path.startsWith("cloud/") ||
    path === "dashboard" ||
    path.startsWith("dashboard/")
  );
}

/**
 * Load and register authenticated console domains. Idempotent; concurrent
 * callers share one in-flight promise. Failures leave status `error` and
 * allow {@link retryPrivateCloudSurfaces} only from the error state.
 * Callers that ignore the promise do not create unhandled rejections.
 */
export function ensurePrivateCloudSurfaces(): Promise<void> {
  if (privateRegistered || snapshot.status === "ready") {
    return Promise.resolve();
  }
  if (privateRegistration) {
    return privateRegistration;
  }

  const generation = ++loadGeneration;
  setSnapshot("pending");

  privateRegistration = (async () => {
    try {
      await privateLoadImpl();
      if (generation !== loadGeneration) {
        // A newer attempt superseded this one — do not commit ready/error.
        return;
      }
      privateRegistered = true;
      privateRegistration = null;
      setSnapshot("ready");
    } catch (cause: unknown) {
      if (generation !== loadGeneration) {
        // Quarantine stale failures (superseded by a newer generation or a
        // test reset). Resolve without mutating the current snapshot so a late
        // reject cannot demote ready → error or surface as unhandledrejection
        // after the fire-and-forget observer has already settled.
        return;
      }
      privateRegistration = null;
      const error =
        cause instanceof Error ? cause : new Error(String(cause ?? "unknown"));
      setSnapshot("error", error);
      throw error;
    }
  })();

  // error-policy:J5 The returned rejection remains observable to explicit
  // callers; fire-and-forget shell calls render snapshot.error in
  // DashboardCatchAll instead of surfacing an unhandled rejection.
  void privateRegistration.catch(() => {});

  return privateRegistration;
}

/**
 * Retry only from the error state. In-flight (pending) attempts are shared —
 * callers receive the existing promise rather than starting a second loader.
 */
export function retryPrivateCloudSurfaces(): Promise<void> {
  if (privateRegistered || snapshot.status === "ready") {
    return Promise.resolve();
  }
  if (snapshot.status === "pending" && privateRegistration) {
    return privateRegistration;
  }
  if (snapshot.status !== "error") {
    return ensurePrivateCloudSurfaces();
  }
  // Clear failed attempt so ensure starts a new generation.
  privateRegistration = null;
  return ensurePrivateCloudSurfaces();
}

/**
 * Test-only reset. Not for production boot paths.
 */
export function resetPrivateCloudRegistrationForTests(): void {
  privateRegistered = false;
  privateRegistration = null;
  // Invalidate any loader that was still pending when the test reset the
  // singleton. Resetting to zero can reuse its generation on the next ensure,
  // allowing that stale completion to overwrite the fresh test state.
  loadGeneration += 1;
  snapshot = IDLE_SNAPSHOT;
  privateLoadImpl = loadPrivateCloudDomains;
  notify();
}

/**
 * Test-only loader override (inject failures / no-op success without network).
 */
export function setPrivateCloudLoadForTests(
  loader: (() => Promise<void>) | null,
): void {
  privateLoadImpl = loader ?? loadPrivateCloudDomains;
}

/**
 * Test-only: drop the shared in-flight promise handle so a **new** generation
 * can start while an older loader is still running. Production code never does
 * this (pending callers share one promise); the hook exists solely so the
 * generation guard can be exercised with reverse completion order.
 */
export function forceNewPrivateCloudGenerationForTests(): Promise<void> {
  privateRegistration = null;
  privateRegistered = false;
  // Leave snapshot as-is (often pending); ensure will bump generation and
  // start a second concurrent loader.
  return ensurePrivateCloudSurfaces();
}
