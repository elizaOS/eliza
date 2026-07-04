/**
 * XR view control actions — re-exported with the canonical names the
 * feature-parity test suite expects.
 *
 * All five actions (XR_OPEN_VIEW, XR_CLOSE_VIEW, XR_SWITCH_VIEW,
 * XR_LIST_VIEWS, XR_RESIZE_VIEW) are implemented in view-actions.ts and
 * re-exported here so tests can import from a single predictable location.
 *
 * Natural-language routing is implemented in view-actions.ts against the
 * runtime view registry, so this module does not need to know about other
 * plugins' view ids.
 */

export {
	collectXRViews,
	extractViewId,
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
