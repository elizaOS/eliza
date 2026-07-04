/**
 * Approvals cloud domain — barrel + route registration.
 *
 * The in-app, owner-facing counterpart to the public token pages
 * (`/approve/:id`, `/ballot/:id`, `/sensitive-requests/:id`). A logged-in owner
 * uses this pane to list and act on their agent's pending approval requests,
 * ballots, and sensitive requests next to chat.
 *
 *  - {@link ApprovalsSurface} is the zero-prop component a settings section /
 *    sidebar host can embed.
 *  - {@link approvalsCloudRoute} is registered **at import time** at
 *    `dashboard/approvals`. This path has no `CloudRouterShell` redirect to
 *    shadow, so eager registration is safe and keeps the standalone deep link
 *    live (same precedent as `dashboard/documents`).
 *    {@link registerApprovalsCloudRoute} is also exported for re-registration at
 *    a custom path if needed.
 */

import { lazy } from "react";
import {
  type CloudRouteDef,
  registerCloudRoute,
} from "@elizaos/ui/cloud/shell/cloud-route-registry";

export { ApprovalsSurface, default as ApprovalsRoute } from "./ApprovalsRoute";
export {
  type ApprovalRequest,
  type Ballot,
  type SensitiveRequest,
  useApprovalRequests,
  useApproveRequest,
  useBallots,
  useCancelBallot,
  useCancelSensitiveRequest,
  useDenyRequest,
  useSensitiveRequest,
  useTallyBallot,
  useVoteBallot,
} from "./lib/approvals";

/** Stable view/section id + URL path slug for the Approvals surface. */
export const APPROVALS_SECTION_ID = "approvals";
export const APPROVALS_ROUTE_PATH = "dashboard/approvals";

/** Lazy route element for the standalone Approvals pane (code-split). */
const ApprovalsRouteLazy = lazy(() => import("./ApprovalsRoute"));

/** Cloud-route definition for the standalone Approvals pane. */
export const approvalsCloudRoute: CloudRouteDef = {
  path: APPROVALS_ROUTE_PATH,
  element: ApprovalsRouteLazy,
  group: "dashboard",
};

/**
 * Register (or re-register) the standalone Approvals route. Exported for an
 * explicit custom-path mount; the default registration below runs at import time
 * since `dashboard/approvals` has no shell redirect to collide with.
 */
export function registerApprovalsCloudRoute(
  override?: Partial<CloudRouteDef>,
): void {
  registerCloudRoute({ ...approvalsCloudRoute, ...override });
}

registerApprovalsCloudRoute();
