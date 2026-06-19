/**
 * Account / Security / Permissions cloud domain — barrel + route registration.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/account/*`,
 * `src/dashboard/security/*`, and `src/dashboard/security/permissions/*`, plus
 * the `src/lib/data/user.ts` hook and the `src/lib/security/*` (audit-client,
 * consent-store) glue. Three surfaces:
 *
 *   - Account     → profile form (PATCH /api/v1/user, /user/email, /user/avatar),
 *                   organization info, account details.
 *   - Security    → sessions (GET/DELETE /api/v1/sessions), MFA read
 *                   (/api/v1/me/mfa), privacy + DSR export/delete
 *                   (/api/v1/me/export, /me/delete-request), audit
 *                   (/api/v1/me/audit-events), incident (/api/v1/security/incident).
 *   - Permissions → plugin grants (GET/DELETE /api/v1/me/plugin-grants).
 *
 * Two mount points per surface, byte-for-byte identical:
 *   - `<Name>Section` — zero-prop component for the Wave-3 settings registry
 *     (`registerSettingsSection({ id, Component })`). Primary home.
 *   - the registered cloud route (this module's side effect) — standalone
 *     `/dashboard/{account,security,security/permissions}` deep links. These
 *     paths have NO compat redirect in `CloudRouterShell`, so registering them
 *     at import time is safe and preserves the deep-link contract.
 *
 * Dropped per migration scope: the stub `SecurityPreferences`
 * (2FA/notifications/delete-account — all dead "Coming Soon" controls).
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

// Surfaces (embeddable bodies) + standalone route components.
export { AccountSurface, default as AccountRoute } from "./AccountRoute";
// Zero-prop settings-section adapters (Wave-3 mount points).
export { AccountSection } from "./AccountSection";
export {
  type SessionAuthState,
  useSessionAuth,
  useStewardAuth,
} from "./data/use-session-auth";
// Data hook + session glue reused by the surfaces.
export { type UserProfile, useUserProfile } from "./data/user";
export {
  default as PermissionsRoute,
  PermissionsSurface,
} from "./PermissionsRoute";
export { PermissionsSection } from "./PermissionsSection";
export { default as SecurityRoute, SecuritySurface } from "./SecurityRoute";
export { SecuritySection } from "./SecuritySection";

/** Stable settings-section ids + URL hashes for the surfaces. */
export const ACCOUNT_SECTION_ID = "account";
export const SECURITY_SECTION_ID = "security";
export const PERMISSIONS_SECTION_ID = "plugin-permissions";

/** Standalone cloud-route paths (no compat redirect; safe to self-register). */
export const ACCOUNT_ROUTE_PATH = "dashboard/account";
export const SECURITY_ROUTE_PATH = "dashboard/security";
export const PERMISSIONS_ROUTE_PATH = "dashboard/security/permissions";

const AccountRouteLazy = lazy(() => import("./AccountRoute"));
const SecurityRouteLazy = lazy(() => import("./SecurityRoute"));
const PermissionsRouteLazy = lazy(() => import("./PermissionsRoute"));

registerCloudRoute({
  path: ACCOUNT_ROUTE_PATH,
  element: AccountRouteLazy,
  group: "dashboard",
});
registerCloudRoute({
  path: SECURITY_ROUTE_PATH,
  element: SecurityRouteLazy,
  group: "dashboard",
});
registerCloudRoute({
  path: PERMISSIONS_ROUTE_PATH,
  element: PermissionsRouteLazy,
  group: "dashboard",
});
