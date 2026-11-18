/** Phone Browser controls from chat: web search, tabs, find in page and page history.
 * Browser-safe, so hosts and tests can use the rules anywhere. Validation rejects
 * rather than truncates.
 *
 * Each group needs its own negotiated capability, so a phone that did not advertise it is
 * never offered or sent the operation. The phone owns everything the agent must not see:
 * it builds the search address with its own search engine, and it finds a tab from a word
 * of its title or host and asks the owner to pick when more than one matches. The agent
 * receives only whether the operation ran. It never receives the tab list, a title, an
 * address or page content.
 *
 * A search uses only words the owner typed in the current message. Closing a tab is
 * always reviewed by the owner. The other controls may run without a review when they
 * are bound to the owner's own current message; otherwise they are reviewed. A tab
 * switch or a find is bound only when the owner typed its words in that message. */
import { BROWSER_SEARCH_QUERY_MAX } from "@elizaos/contracts/browser-request-grounding";

export const BROWSER_SEARCH_CAPABILITY = "browser.search.v1";
export const BROWSER_TABS_CAPABILITY = "browser.tabs.v1";
export const BROWSER_FIND_CAPABILITY = "browser.find.v1";
export const BROWSER_HISTORY_CAPABILITY = "browser.history.v1";
/** A typed address opened in a tab of its own: browser_navigate {url, newTab: true}.
 * Without it the phone may open the address in its own earlier tab, replacing that page. */
export const BROWSER_OPEN_NEW_TAB_CAPABILITY = "browser.open-new-tab.v1";

export const BROWSER_TAB_TARGET_MAX = 128;
export const BROWSER_FIND_TEXT_MAX = 256;
export const BROWSER_HISTORY_ACTIONS = [
  "back",
  "forward",
  "reload",
  "stop",
] as const;
export type BrowserHistoryAction = (typeof BROWSER_HISTORY_ACTIONS)[number];

export type BrowserControlOperation =
  | { type: "browser_search"; query: string }
  | { type: "browser_tab_new"; private?: boolean }
  | { type: "browser_tab_switch"; target: string }
  | { type: "browser_tab_close"; target?: string }
  | { type: "browser_find"; text: string }
  | { type: "browser_history"; action: BrowserHistoryAction };
export type BrowserControlType = BrowserControlOperation["type"];

const CAPABILITY: Record<BrowserControlType, string> = {
  browser_search: BROWSER_SEARCH_CAPABILITY,
  browser_tab_new: BROWSER_TABS_CAPABILITY,
  browser_tab_switch: BROWSER_TABS_CAPABILITY,
  browser_tab_close: BROWSER_TABS_CAPABILITY,
  browser_find: BROWSER_FIND_CAPABILITY,
  browser_history: BROWSER_HISTORY_CAPABILITY,
};
export const BROWSER_CONTROL_TYPES = Object.keys(
  CAPABILITY,
) as BrowserControlType[];
/** May run without a review only when bound to the owner's own current message. */
export const BROWSER_CONTROL_DIRECT_TYPES: readonly BrowserControlType[] = [
  "browser_search",
  "browser_tab_new",
  "browser_tab_switch",
  "browser_find",
  "browser_history",
];

export function isBrowserControlType(
  type: unknown,
): type is BrowserControlType {
  return typeof type === "string" && Object.hasOwn(CAPABILITY, type);
}
export function isBrowserControl(
  value: unknown,
): value is BrowserControlOperation {
  return (
    !!value &&
    typeof value === "object" &&
    isBrowserControlType((value as { type?: unknown }).type)
  );
}
export function browserControlCapabilityAvailable(
  type: BrowserControlType,
  capabilities?: readonly string[],
): boolean {
  return capabilities?.includes(CAPABILITY[type]) === true;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: owner text must reject control characters.
const CONTROL = /[\u0000-\u001f\u007f]/;
function words(value: unknown, max: number, message: string): string {
  if (typeof value !== "string" || CONTROL.test(value)) throw Error(message);
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text.length > max) throw Error(message);
  return text;
}

export function validateBrowserControl(
  value: unknown,
): BrowserControlOperation {
  if (!isBrowserControl(value)) throw Error("Unsupported Browser operation");
  const op = value as Record<string, unknown>;
  const allowed = (keys: string[]) => {
    for (const key of Object.keys(op))
      if (key !== "type" && !keys.includes(key))
        throw Error("Unexpected Browser field");
  };
  switch (value.type) {
    case "browser_search":
      allowed(["query"]);
      return {
        type: value.type,
        query: words(
          op.query,
          BROWSER_SEARCH_QUERY_MAX,
          "Invalid search query",
        ),
      };
    case "browser_tab_new":
      allowed(["private"]);
      if (op.private !== undefined && typeof op.private !== "boolean")
        throw Error("Invalid private tab flag");
      return { type: value.type, ...(op.private ? { private: true } : {}) };
    case "browser_tab_switch":
      allowed(["target"]);
      return {
        type: value.type,
        target: words(op.target, BROWSER_TAB_TARGET_MAX, "Invalid tab target"),
      };
    case "browser_tab_close":
      allowed(["target"]);
      return {
        type: value.type,
        ...(op.target !== undefined
          ? {
              target: words(
                op.target,
                BROWSER_TAB_TARGET_MAX,
                "Invalid tab target",
              ),
            }
          : {}),
      };
    case "browser_find":
      allowed(["text"]);
      return {
        type: value.type,
        text: words(op.text, BROWSER_FIND_TEXT_MAX, "Invalid find text"),
      };
    case "browser_history":
      allowed(["action"]);
      if (!BROWSER_HISTORY_ACTIONS.some((action) => action === op.action))
        throw Error("Invalid history action");
      return { type: value.type, action: op.action as BrowserHistoryAction };
  }
}

const quoted = (value: string) => `“${value}”`;
const HISTORY_TITLES: Record<BrowserHistoryAction, string> = {
  back: "Go back",
  forward: "Go forward",
  reload: "Reload page",
  stop: "Stop loading",
};
/** The review card: the change itself, nothing else. */
export function describeBrowserControl(op: BrowserControlOperation): {
  title: string;
  description: string;
} {
  switch (op.type) {
    case "browser_search":
      return {
        title: "Search the web",
        description: `${quoted(op.query)}\n\nOpens a web search for these words in Browser, with your search engine.`,
      };
    case "browser_tab_new":
      return {
        title: op.private ? "Open a private tab" : "Open a new tab",
        description:
          "Opens an empty tab in Browser. An address opens in a new tab with browser_navigate and newTab.",
      };
    case "browser_tab_switch":
      return {
        title: "Switch tab",
        description: `Tab matching ${quoted(op.target)}\n\nYour phone finds the tab. You pick one when more than one matches. The agent does not see your tabs.`,
      };
    case "browser_tab_close":
      return {
        title: "Close tab",
        description: op.target
          ? `Tab matching ${quoted(op.target)}\n\nYour phone finds the tab. You pick one when more than one matches. The agent does not see your tabs.`
          : "Closes the tab that is showing in Browser.",
      };
    case "browser_find":
      return {
        title: "Find in page",
        description: `${quoted(op.text)}\n\nShows the matches on the page that is open in Browser. The agent does not see the page.`,
      };
    case "browser_history":
      return {
        title: HISTORY_TITLES[op.action],
        description: "Acts on the tab that is showing in Browser.",
      };
  }
}
