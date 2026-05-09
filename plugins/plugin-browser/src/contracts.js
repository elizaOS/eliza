/**
 * Agent Browser Bridge contracts.
 *
 * Transport/domain types for the generic browser companion + packaging
 * surface. LifeOps workflow-bound browser *sessions* (with scoping columns
 * and workflowId) remain in `@elizaos/shared/contracts/lifeops` and
 * continue to reference `BrowserBridgeKind` / `BrowserBridgeAction` from
 * this module.
 */
export const BROWSER_BRIDGE_KINDS = ["chrome", "safari"];
export const BROWSER_BRIDGE_TRACKING_MODES = [
    "off",
    "current_tab",
    "active_tabs",
];
export const BROWSER_BRIDGE_SITE_ACCESS_MODES = [
    "current_site_only",
    "granted_sites",
    "all_sites",
];
export const BROWSER_BRIDGE_COMPANION_CONNECTION_STATES = [
    "disconnected",
    "connected",
    "paused",
    "permission_blocked",
];
export const BROWSER_BRIDGE_COMPANION_AUTH_ERROR_CODES = [
    "browser_bridge_companion_auth_missing_id",
    "browser_bridge_companion_auth_missing_token",
    "browser_bridge_companion_pairing_invalid",
    "browser_bridge_companion_token_expired",
    "browser_bridge_companion_token_revoked",
];
export const BROWSER_BRIDGE_ACTION_KINDS = [
    "open",
    "navigate",
    "focus_tab",
    "back",
    "forward",
    "reload",
    "click",
    "type",
    "submit",
    "read_page",
    "extract_links",
    "extract_forms",
];
export const BROWSER_BRIDGE_PACKAGE_PATH_TARGETS = [
    "extension_root",
    "chrome_build",
    "chrome_package",
    "safari_web_extension",
    "safari_app",
    "safari_package",
];
