/**
 * Route-owned private cloud surface registration (#18056).
 *
 * Public boot only registers public/auth routes. Private dashboard/settings
 * domains are loaded when a private path is actually visited, via
 * {@link ensurePrivateCloudSurfaces}. Status is observable so the shell can
 * show pending / retry / real-404 without fire-and-forget races.
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

let privateRegistered = false;
let privateRegistration: Promise<void> | null = null;
let status: PrivateCloudRegistrationStatus = "idle";
let lastError: Error | null = null;
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
  status = next;
  lastError = error;
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

/** Snapshot for `useSyncExternalStore`. */
export function getPrivateCloudRegistrationSnapshot(): PrivateCloudRegistrationSnapshot {
  return { status, error: lastError };
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
 * allow {@link retryPrivateCloudSurfaces}. Callers that ignore the promise
 * do not create unhandled rejections — errors are retained on the snapshot.
 */
export function ensurePrivateCloudSurfaces(): Promise<void> {
  if (privateRegistered || status === "ready") {
    return Promise.resolve();
  }
  if (privateRegistration) {
    return privateRegistration;
  }

  setSnapshot("pending");

  privateRegistration = (async () => {
    await privateLoadImpl();
    privateRegistered = true;
    setSnapshot("ready");
  })().catch((cause: unknown) => {
    privateRegistration = null;
    const error =
      cause instanceof Error ? cause : new Error(String(cause ?? "unknown"));
    setSnapshot("error", error);
    throw error;
  });

  // Attach a silent observer so fire-and-forget callers never surface an
  // unhandledrejection; awaiters still receive the rejection.
  void privateRegistration.catch(() => {});

  return privateRegistration;
}

/** Clear a failed attempt and load private domains again. */
export function retryPrivateCloudSurfaces(): Promise<void> {
  if (status === "ready" || privateRegistered) {
    return Promise.resolve();
  }
  privateRegistration = null;
  if (status === "error") {
    setSnapshot("idle");
  }
  return ensurePrivateCloudSurfaces();
}

/**
 * Test-only reset. Not for production boot paths.
 */
export function resetPrivateCloudRegistrationForTests(): void {
  privateRegistered = false;
  privateRegistration = null;
  status = "idle";
  lastError = null;
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
