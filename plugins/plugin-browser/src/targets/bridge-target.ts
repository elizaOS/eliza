/**
 * Bridge target — routes a `BrowserWorkspaceCommand` to the Agent Browser
 * Bridge companion (Chrome / Safari) via `BrowserBridgeRouteService`.
 *
 * The bridge surface is intentionally narrower than the workspace surface.
 * It speaks at the level of paired browser tabs, not of an embedded
 * BrowserView, so subactions like `eval` / `pdf` / `trace` / `profiler`
 * have no clean translation. We translate the read-mostly subset that DOES
 * map cleanly:
 *
 *   list            → list companion-tracked tabs
 *   state           → snapshot of current page context
 *   open            → ask the companion to open a URL in a new tab
 *   navigate        → ask the companion to navigate the current/named tab
 *   close           → ask the companion to close a tab
 *   show / hide     → focus / unfocus a tab in the companion window
 *   get             → return the current page text/title/url
 *   back / forward / reload → companion navigation history nav
 *
 * Anything outside that subset throws a clear error so the caller
 * (typically the BROWSER action) can surface a "this isn't supported on
 * the bridge target — try the workspace target" message back to the user.
 *
 * The bridge protocol's session-tracking semantics (`createBrowserSession`,
 * `confirmBrowserSession`, etc.) are LifeOps workflow concerns and live
 * in a dedicated lifeops session action, not here.
 */

import type { BrowserBridgeTabSummary } from "../contracts.js";
import type { BrowserBridgeRouteService } from "../service.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceTab,
} from "../workspace/browser-workspace-types.js";

/**
 * Subactions the bridge can execute directly without a LifeOps session.
 * These are read-mostly operations that map cleanly to the companion's
 * tab/page-context API.
 */
const BRIDGE_DIRECT_SUBACTIONS = new Set<BrowserWorkspaceCommand["subaction"]>([
  "list",
  "state",
  "get",
  "tab",
]);

/**
 * Subactions that require a LifeOps browser session to record and gate
 * account-affecting operations behind owner confirmation. The bridge's session
 * APIs are not called from the generic BROWSER target, so these are advertised
 * as unsupported in the pre-dispatch capability manifest — the dispatcher will
 * skip the bridge and select a genuinely capable target instead of selecting
 * the bridge and hitting a known rejection.
 *
 * (issue #18258 review: previously these were in SUPPORTED_SUBACTIONS, causing
 * the bridge to be selected as "capable" and then unconditionally rejecting
 * at execute time, mislabeling side-effecting commands as UNCERTAIN_OUTCOME.)
 */
const SESSION_GATED_SUBACTIONS = new Set<BrowserWorkspaceCommand["subaction"]>([
  "open",
  "navigate",
  "close",
  "show",
  "hide",
  "back",
  "forward",
  "reload",
]);

/**
 * All subactions the bridge recognizes (direct + session-gated). The executor
 * switch still handles the session-gated case to give a clear, actionable error
 * when a caller pins target=bridge explicitly.
 */
const ALL_RECOGNIZED_SUBACTIONS = new Set([
  ...BRIDGE_DIRECT_SUBACTIONS,
  ...SESSION_GATED_SUBACTIONS,
]);

/**
 * Capability manifest for the bridge target. Exported so the BrowserService
 * bridge-target factory can wire a `supports()` pre-dispatch check from the
 * same single source of truth (issue #18258).
 *
 * Only includes subactions the bridge can execute directly — session-gated
 * operations are excluded so the pre-dispatch capability check skips the
 * bridge for them.
 */
export const BRIDGE_SUPPORTED_SUBACTIONS: ReadonlySet<string> =
  BRIDGE_DIRECT_SUBACTIONS;

function bridgeTabToWorkspaceTab(
  tab: BrowserBridgeTabSummary,
): BrowserWorkspaceTab {
  // The bridge speaks BrowserBridgeTabSummary; the BROWSER action expects
  // BrowserWorkspaceTab. Map the overlapping fields and use defaults for the rest.
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    partition: `bridge:${tab.profileId}`,
    kind: "standard",
    visible: tab.activeInWindow,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    lastFocusedAt: tab.lastFocusedAt,
  };
}

function unsupported(subaction: BrowserWorkspaceCommand["subaction"]): Error {
  return new Error(
    `Browser bridge target does not support subaction "${subaction}". Use the workspace target for embedded-browser features (eval, pdf, snapshot, trace, profiler, etc.).`,
  );
}

export async function dispatchBridgeCommand(
  service: BrowserBridgeRouteService,
  command: BrowserWorkspaceCommand,
): Promise<BrowserWorkspaceCommandResult> {
  if (!ALL_RECOGNIZED_SUBACTIONS.has(command.subaction)) {
    throw unsupported(command.subaction);
  }
  switch (command.subaction) {
    case "list":
    case "tab":
      // Bridge `tab` always behaves like list; the bridge has no concept of
      // creating an internal tab via the agent — the user owns the tabs.
      return {
        mode: "desktop",
        subaction: command.subaction,
        tabs: (await service.listBrowserTabs()).map(bridgeTabToWorkspaceTab),
      };
    case "state": {
      const page = await service.getCurrentBrowserPage();
      return {
        mode: "desktop",
        subaction: command.subaction,
        // State is the read contract for a synchronized companion page. Keep
        // the complete owner-scoped context so callers can ground replies in
        // selected text, headings, links, and forms instead of re-fetching the
        // page through a second, potentially divergent path.
        value: page,
      };
    }
    case "get": {
      const page = await service.getCurrentBrowserPage();
      if (!page) {
        return {
          mode: "desktop",
          subaction: command.subaction,
          value: null,
        };
      }
      const mode = command.getMode ?? "text";
      const value =
        mode === "url"
          ? page.url
          : mode === "title"
            ? page.title
            : (page.mainText ?? "");
      return { mode: "desktop", subaction: command.subaction, value };
    }
    // open / navigate / close / show / hide / back / forward / reload are
    // session-creating operations on the bridge — they require a
    // LifeOpsBrowserSession to record the action and gate confirmation.
    // The bridge's session APIs aren't appropriate to call from a generic
    // BROWSER target, so we throw a clear error directing the caller to
    // the dedicated lifeops session action.
    case "open":
    case "navigate":
    case "close":
    case "show":
    case "hide":
    case "back":
    case "forward":
    case "reload":
      throw new Error(
        `Bridge target subaction "${command.subaction}" requires a recorded LifeOpsBrowserSession (the bridge gates account-affecting ops behind owner confirmation). Use the lifeops browser-session action to start a session, or pin target=workspace for embedded-browser tabs.`,
      );
    default:
      throw unsupported(command.subaction);
  }
}
