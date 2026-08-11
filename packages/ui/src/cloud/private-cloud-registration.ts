/**
 * Route-owned private cloud surface registration (#18056).
 *
 * Public boot only registers public/auth routes. Private dashboard/settings
 * domains are loaded when a private path is actually visited, via
 * {@link ensurePrivateCloudSurfaces}. Status is observable so the shell can
 * show pending / retry / real-404 without fire-and-forget races.
 *
 * Snapshot identity is stable for `useSyncExternalStore` (one module-level
 * object replaced only on real state transitions). Completions are
 * generation-guarded so an obsolete failed attempt cannot overwrite a newer
 * successful one.
 */

import { lazy } from "react";
import { registerCloudRoute } from "./shell/cloud-route-registry";

/** Stable Applications paths (console no longer hosts Apps; see override below). */
const APPLICATIONS_LIST_ROUTE_PATH = "dashboard/apps";
const APPLICATIONS_DETAIL_ROUTE_PATH = "dashboard/apps/:id";

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

  // The console no longer surfaces Apps — management moved into the Eliza
  // app. Override both paths (later same-path registration wins) so a stale
  // /dashboard/apps link redirects to the dashboard. Do not import the
  // Applications barrel: it eagerly re-exports heavy page modules.
  const AppsMovedRoute = lazy(() => import("./applications/AppsMovedRoute"));
  registerCloudRoute({
    path: APPLICATIONS_LIST_ROUTE_PATH,
    element: AppsMovedRoute,
    group: "dashboard",
  });
  registerCloudRoute({
    path: APPLICATIONS_DETAIL_ROUTE_PATH,
    element: AppsMovedRoute,
    group: "dashboard",
  });

  registerAdminCloudRoutes();
  registerMcpsCloudRoute();
  registerCloudSettingsSections();
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
 * True when the URL requires private cloud domains (dashboard / console).
 * Public auth and marketing paths must stay false so idle `/login` never
 * starts private chunk downloads.
 */
export function pathNeedsPrivateCloudSurfaces(pathname: string): boolean {
  const path = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return path === "dashboard" || path.startsWith("dashboard/");
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
        return;
      }
      privateRegistration = null;
      const error =
        cause instanceof Error ? cause : new Error(String(cause ?? "unknown"));
      setSnapshot("error", error);
      throw error;
    }
  })();

  // Silent observer so fire-and-forget never surfaces unhandledrejection.
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
  loadGeneration = 0;
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
