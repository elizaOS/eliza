/**
 * Admin cloud domain — barrel + route registration.
 *
 * Business-admin surfaces, behind ONE consolidated role gate:
 * {@link useAdminGate} is the single source of truth — the moderation HEAD
 * endpoint (`X-Is-Admin` / `X-Admin-Role`) with the documented dev rule
 * (local dev: any authed user is super_admin; prod: the role gate decides).
 * Every route wraps its body in {@link AdminGate}, which also renders the
 * shared admin sub-nav.
 */

import { lazy } from "react";
import {
  type CloudRouteDef,
  registerCloudRoute,
} from "../shell/cloud-route-registry";

export { AdminGate } from "./AdminGate";
export {
  type AdminGateStatus,
  isAdminDevBypass,
  type UseAdminGateResult,
  useAdminGate,
} from "./data/use-admin-gate";
export { default as ModerationRoute } from "./ModerationRoute";
export { default as RedemptionsRoute } from "./RedemptionsRoute";
export { default as RpcStatusRoute } from "./RpcStatusRoute";

/** Stable cloud-route paths (no compat redirect; safe to self-register). */
export const ADMIN_MODERATION_ROUTE_PATH = "dashboard/admin";
export const ADMIN_REDEMPTIONS_ROUTE_PATH = "dashboard/admin/redemptions";
export const ADMIN_RPC_STATUS_ROUTE_PATH = "dashboard/admin/rpc-status";

/** Lazy route elements (code-split) for the admin surfaces. */
const ModerationRouteLazy = lazy(() => import("./ModerationRoute"));
const RedemptionsRouteLazy = lazy(() => import("./RedemptionsRoute"));
const RpcStatusRouteLazy = lazy(() => import("./RpcStatusRoute"));

/** Cloud-route definition for the moderation panel (`dashboard/admin`). */
export const adminModerationCloudRoute: CloudRouteDef = {
  path: ADMIN_MODERATION_ROUTE_PATH,
  element: ModerationRouteLazy,
  group: "admin",
};

/** Cloud-route definition for redemptions (`dashboard/admin/redemptions`). */
export const adminRedemptionsCloudRoute: CloudRouteDef = {
  path: ADMIN_REDEMPTIONS_ROUTE_PATH,
  element: RedemptionsRouteLazy,
  group: "admin",
};

/** Cloud-route definition for RPC status (`dashboard/admin/rpc-status`). */
export const adminRpcStatusCloudRoute: CloudRouteDef = {
  path: ADMIN_RPC_STATUS_ROUTE_PATH,
  element: RpcStatusRouteLazy,
  group: "admin",
};

/**
 * Register (or re-register) all admin routes. Exported for an explicit mount;
 * the default registration below runs at import time.
 */
export function registerAdminCloudRoutes(): void {
  registerCloudRoute(adminModerationCloudRoute);
  registerCloudRoute(adminRedemptionsCloudRoute);
  registerCloudRoute(adminRpcStatusCloudRoute);
}

registerAdminCloudRoutes();
