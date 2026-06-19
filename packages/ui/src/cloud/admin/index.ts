/**
 * Admin cloud domain — barrel + route registration.
 *
 * Business-admin surfaces moved in-app behind ONE consolidated role gate
 * (DECISIONS.md / PLAN.md §3 "Admin split"). Lifted from
 * `@elizaos/cloud-frontend/src/dashboard/admin/*`:
 *
 *   - Moderation  → `dashboard/admin`             (`/api/v1/admin/moderation`)
 *   - Redemptions → `dashboard/admin/redemptions` (`/api/admin/redemptions`,
 *                                                   `/api/v1/redemptions/status`)
 *   - RPC status  → `dashboard/admin/rpc-status`  (`/admin/rpc-status`)
 *
 * The infra dashboard (3252-line `infrastructure-dashboard.tsx`) and the metrics
 * console are intentionally NOT ported — they stay a separate internal ops
 * console (super_admin + `ssh2` Node-only, 501-stubbed on Workers) and add
 * nothing to the consumer app.
 *
 * Role gate consolidation: cloud-frontend had two parallel admin hooks
 * (`lib/data/admin.ts` + `hooks/use-admin.ts`) and four dev-bypass conventions.
 * Here {@link useAdminGate} is the single source of truth — the moderation HEAD
 * endpoint (`X-Is-Admin` / `X-Admin-Role`) with the documented dev rule
 * (local dev: any authed user is super_admin; prod: the role gate decides). Every
 * route wraps its body in {@link AdminGate}, which also renders the shared admin
 * sub-nav. These paths have NO compat redirect in `CloudRouterShell`, so
 * registering them at import time is safe and preserves the deep-link contract.
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
