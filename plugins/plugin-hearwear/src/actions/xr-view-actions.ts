/**
 * XR view control actions — re-exported with the canonical names the
 * feature-parity test suite expects.
 *
 * All five actions (XR_OPEN_VIEW, XR_CLOSE_VIEW, XR_SWITCH_VIEW,
 * XR_LIST_VIEWS, XR_RESIZE_VIEW) are implemented in view-actions.ts and
 * re-exported here so tests can import from a single predictable location.
 *
 * The extractViewId helper below extends the one in view-actions.ts with
 * the complete set of all 25 registered XR view IDs.
 */

export {
  xrCloseViewAction as XR_CLOSE_VIEW,
  xrCloseViewAction,
  xrListViewsAction as XR_LIST_VIEWS,
  xrListViewsAction,
  xrOpenViewAction as XR_OPEN_VIEW,
  xrOpenViewAction,
  xrResizeViewAction as XR_RESIZE_VIEW,
  xrResizeViewAction,
  xrSwitchViewAction as XR_SWITCH_VIEW,
  xrSwitchViewAction,
} from "./view-actions.ts";

/**
 * All 25 registered XR view IDs.
 * Used by extractViewId() for natural-language routing.
 */
export const ALL_XR_VIEW_IDS = [
  "wallet",
  "companion",
  "training",
  "task-coordinator",
  "views-manager",
  "polymarket",
  "vincent",
  "steward",
  "shopify",
  "phone",
  "contacts",
  "messages",
  "feed",
  "2004scape",
  "defense-of-the-agents",
  "clawville",
  "hyperliquid",
  "hyperscape",
  "lifeops",
  "scape",
  "screenshare",
  "trajectory-logger",
  "model-tester",
  "smartglasses",
  "hearwear",
] as const;

export type XRViewId = (typeof ALL_XR_VIEW_IDS)[number];

/**
 * Extract a view id from natural-language text.
 * Checks all 25 registered view ids in order, matching by word or slug.
 */
export function extractViewId(text: string): XRViewId | "" {
  const lower = text.toLowerCase();
  for (const id of ALL_XR_VIEW_IDS) {
    if (lower.includes(id) || lower.includes(id.replace(/-/g, " "))) {
      return id;
    }
  }
  // Try quoted identifier
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted) {
    const q = quoted[1]?.toLowerCase() ?? "";
    for (const id of ALL_XR_VIEW_IDS) {
      if (q === id) return id;
    }
  }
  return "";
}
