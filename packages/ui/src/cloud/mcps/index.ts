/**
 * MCPs cloud domain — barrel + route/section registration.
 *
 * The MCP registry management surface, backed by live registry data:
 *
 *   - `GET/POST     /api/v1/mcps`              list (own/public/all) + create
 *   - `GET/PUT/DELETE /api/v1/mcps/:mcpId`     detail / update / delete
 *   - `POST/DELETE  /api/v1/mcps/:mcpId/publish` publish / unpublish
 *   - `GET /api/mcp/list`                       built-in platform catalog
 *   - `GET /api/mcp/proxy/:mcpId`              real connection test (live MCP)
 *
 * Mount points (mirroring `api-keys` / `documents`):
 *  - {@link McpsSection} is the zero-prop component for
 *    `registerSettingsSection({ id: "mcps", Component: McpsSection })`. Exposed
 *    via {@link registerMcpsSettingsSection} (opt-in; the settings IA decision
 *    belongs to the host, and the pinned `settings-section-meta` is owned
 *    elsewhere — so MCPs registers under the existing `system` group).
 *  - {@link mcpsCloudRoute} is registered **at import time** at `dashboard/mcps`
 *    (no `CloudRouterShell` redirect collides with it), so the standalone deep
 *    link is live. {@link registerMcpsCloudRoute} re-registers at a custom path.
 */

import { Boxes } from "lucide-react";
import { lazy } from "react";
import { registerSettingsSection } from "../../components/settings/settings-section-registry";
import {
  type CloudRouteDef,
  registerCloudRoute,
} from "../shell/cloud-route-registry";
import { McpsSection } from "./McpsSection";

export type {
  BuiltinMcpDefinition,
  CreateUserMcpInput,
  McpCategory,
  McpPricingType,
  McpStats,
  McpStatus,
  McpTool,
  UpdateUserMcpInput,
  UserMcpDetailResponse,
  UserMcpRecord,
} from "./lib/api-types";
export {
  useCreateMcp,
  useDeleteMcp,
  usePublishMcp,
  useUnpublishMcp,
  useUpdateMcp,
} from "./lib/mcp-mutations";
export {
  builtinMetadataUrl,
  type McpConnectionTestResult,
  testBuiltinMcpConnection,
  testUserMcpConnection,
} from "./lib/test-connection";
export {
  MCPS_QUERY_KEY,
  useBuiltinMcps,
  usePublicMcps,
  useUserMcpDetail,
  useUserMcps,
} from "./lib/use-mcps";
export { McpDetailDrawer } from "./McpDetailDrawer";
export { McpEditorDialog } from "./McpEditorDialog";
export { default as McpsRoute, McpsSurface } from "./McpsRoute";
export { McpsSection } from "./McpsSection";
export { McpsView } from "./McpsView";

/** Stable settings-section id + URL hash for the MCPs surface. */
export const MCPS_SECTION_ID = "mcps";
/** Stable URL path slug for the standalone MCPs route. */
export const MCPS_ROUTE_PATH = "dashboard/mcps";

/** Lazy route element for the standalone MCPs surface (code-split). */
const McpsRouteLazy = lazy(() => import("./McpsRoute"));

/** Cloud-route definition for the standalone MCPs surface. */
export const mcpsCloudRoute: CloudRouteDef = {
  path: MCPS_ROUTE_PATH,
  element: McpsRouteLazy,
  group: "dashboard",
};

/**
 * Register (or re-register) the standalone MCPs route. The default registration
 * below runs at import time since `dashboard/mcps` has no shell redirect to
 * collide with.
 */
export function registerMcpsCloudRoute(
  override?: Partial<CloudRouteDef>,
): void {
  registerCloudRoute({ ...mcpsCloudRoute, ...override });
}

/**
 * Register the MCPs surface as a Settings section. Idempotent (the registry
 * replaces by id). Not invoked at import time — the host's cloud boot path calls
 * this so the settings IA stays the host's decision. Uses the existing `system`
 * group (the pinned settings-section-meta has no separate "cloud" group).
 */
export function registerMcpsSettingsSection(): void {
  registerSettingsSection({
    id: MCPS_SECTION_ID,
    label: "settings.sections.mcps.label",
    defaultLabel: "MCP Servers",
    icon: Boxes,
    tone: "accent",
    hue: "accent",
    group: "system",
    titleKey: "settings.sections.mcps.title",
    defaultTitle: "MCP Servers",
    Component: McpsSection,
  });
}

registerMcpsCloudRoute();
