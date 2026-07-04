/**
 * `@elizaos/cloud-ui` — Eliza Cloud product UI.
 *
 * Every cloud feature area in this package self-registers into `@elizaos/ui`'s
 * shared registries at import time:
 *   - dashboard / public / auth / payment routes → the cloud-route registry
 *     (`@elizaos/ui/cloud/shell/cloud-route-registry`),
 *   - account-management panes → the settings-section registry
 *     (`@elizaos/ui/components/settings/settings-section-registry`).
 *
 * Those registries are keyed on a process-global symbol, so a route registered
 * here lands in the same store the trunk `CloudRouterShell` reads — no shared
 * route table to edit, no build-config aliasing.
 *
 * Importing this barrel runs each feature module's top-level registration. The
 * app shell only imports it inside the `__ELIZA_WEB_SHELL__`-guarded lazy block,
 * so cloud-free builds (mobile / `ELIZA_DISABLE_WEB_SHELL=1`) drop the whole
 * package statically — with no passthrough stub alias for anything it owns.
 *
 * `registerCloudUiSurfaces()` is the explicit, idempotent boot hook the shell
 * calls alongside `registerAllCloudSurfaces()` from the trunk.
 */

// Side-effecting feature modules: importing them runs their top-level
// `registerCloudRoute(...)` calls.
import { registerApprovalsCloudRoute } from "./approvals";

export {
  APPROVALS_ROUTE_PATH,
  APPROVALS_SECTION_ID,
  type ApprovalRequest,
  ApprovalsRoute,
  ApprovalsSurface,
  approvalsCloudRoute,
  type Ballot,
  registerApprovalsCloudRoute,
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
} from "./approvals";

let registered = false;

/**
 * Register every cloud-ui surface against `@elizaos/ui`'s shared registries.
 * Idempotent and safe to call from the app shell on every boot (each underlying
 * registration is keyed by route path / section id).
 */
export function registerCloudUiSurfaces(): void {
  if (registered) return;
  registered = true;

  registerApprovalsCloudRoute();
}
