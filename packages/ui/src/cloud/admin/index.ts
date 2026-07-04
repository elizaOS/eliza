/**
 * Admin cloud domain — barrel + route registration.
 *
 * Business-admin surfaces, behind ONE consolidated role gate:
 * {@link useAdminGate} is the single source of truth — the moderation HEAD
 * endpoint (`X-Is-Admin` / `X-Admin-Role`) with the documented dev rule
 * (local dev: any authed user is super_admin; prod: the role gate decides).
 *
 * Each route declares `gate: "admin"` (#12087 Item 23) and the shell wraps the
 * body in {@link AdminGate} centrally — routes no longer self-wrap, and a body
 * that forgets to gate itself is still gated. The `"admin"` gate (which also
 * renders the shared admin sub-nav) is registered with the shell here at import
 * time, next to the route registration.
 */

import { lazy } from "react";
import {
  type CloudRouteDef,
  registerCloudRoute,
  registerCloudRouteGate,
} from "../shell/cloud-route-registry";
import { AdminGate } from "./AdminGate";

/** Gate key the admin routes declare; resolves to {@link AdminGate}. */
export const ADMIN_ROUTE_GATE = "admin";

export { AdminGate } from "./AdminGate";
export {
  type AdminGateStatus,
  isAdminDevBypass,
  type UseAdminGateResult,
  useAdminGate,
} from "./data/use-admin-gate";

/** Stable cloud-route paths (no compat redirect; safe to self-register). */
export const ADMIN_MODERATION_ROUTE_PATH = "dashboard/admin";
export const ADMIN_REDEMPTIONS_ROUTE_PATH = "dashboard/admin/redemptions";
export const ADMIN_RPC_STATUS_ROUTE_PATH = "dashboard/admin/rpc-status";

/** Lazy page elements (code-split). The shell applies the `admin` gate. */
const ModerationPageLazy = lazy(() => import("./ModerationPage"));
const RedemptionsPageLazy = lazy(() => import("./RedemptionsPage"));
const RpcStatusPageLazy = lazy(() => import("./RpcStatusPage"));

/** Cloud-route definition for the moderation panel (`dashboard/admin`). */
export const adminModerationCloudRoute: CloudRouteDef = {
  path: ADMIN_MODERATION_ROUTE_PATH,
  element: ModerationPageLazy,
  group: "admin",
  gate: ADMIN_ROUTE_GATE,
};

/** Cloud-route definition for redemptions (`dashboard/admin/redemptions`). */
export const adminRedemptionsCloudRoute: CloudRouteDef = {
  path: ADMIN_REDEMPTIONS_ROUTE_PATH,
  element: RedemptionsPageLazy,
  group: "admin",
  gate: ADMIN_ROUTE_GATE,
};

/** Cloud-route definition for RPC status (`dashboard/admin/rpc-status`). */
export const adminRpcStatusCloudRoute: CloudRouteDef = {
  path: ADMIN_RPC_STATUS_ROUTE_PATH,
  element: RpcStatusPageLazy,
  group: "admin",
  gate: ADMIN_ROUTE_GATE,
};

/**
 * Register (or re-register) all admin routes + the `admin` gate. Exported for
 * an explicit mount; the default registration below runs at import time.
 */
export function registerAdminCloudRoutes(): void {
  registerCloudRouteGate(ADMIN_ROUTE_GATE, AdminGate);
  registerCloudRoute(adminModerationCloudRoute);
  registerCloudRoute(adminRedemptionsCloudRoute);
  registerCloudRoute(adminRpcStatusCloudRoute);
}

registerAdminCloudRoutes();
