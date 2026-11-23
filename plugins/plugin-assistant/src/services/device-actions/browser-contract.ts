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
 * always reviewed by the owner. Closing every open tab (browser_tab_close {all: true}) is
 * its own negotiated form: the phone lists the tabs it will close on that one review card,
 * because only the phone knows them, and closes exactly those. A phone that did not
 * negotiate it is never sent it, so a request to close several tabs is refused rather
 * than narrowed to the tab that is showing. The other controls may run without a review when they
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
/** Every open tab closed by one reviewed browser_tab_close {all: true}. Needs browser.tabs.v1 too. */
export const BROWSER_TABS_CLOSE_ALL_CAPABILITY = "browser.tabs.close-all.v1";
/** The phone's own list of open tabs brought to the front (browser_tabs_show). The list
 * stays on the phone: the agent learns only whether it is showing. */
export const BROWSER_TABS_SHOW_CAPABILITY = "browser.tabs.show.v1";

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
  | { type: "browser_tab_close"; target?: string; all?: true }
  | { type: "browser_tabs_show" }
  | { type: "browser_find"; text: string }
  | { type: "browser_history"; action: BrowserHistoryAction };
export type BrowserControlType = BrowserControlOperation["type"];

const CAPABILITY: Record<BrowserControlType, string> = {
  browser_search: BROWSER_SEARCH_CAPABILITY,
  browser_tab_new: BROWSER_TABS_CAPABILITY,
  browser_tab_switch: BROWSER_TABS_CAPABILITY,
  browser_tab_close: BROWSER_TABS_CAPABILITY,
  browser_tabs_show: BROWSER_TABS_SHOW_CAPABILITY,
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
  "browser_tabs_show",
  "browser_find",
  "browser_history",
];

/**
 * A whole message that asks only to see the open Browser tabs: "show my open
 * tabs", "list my tabs", "what tabs do I have open?". An optional leading
 * assistant name and please are allowed; anything more is left to the model.
 */
export function asksToSeeBrowserTabs(
  text: string,
  assistantName?: string,
): boolean {
  let request = text
    .trim()
    .toLowerCase()
    .replace(/[\s.!?]+$/, "");
  const name = assistantName?.trim().toLowerCase();
  request = request.replace(/^(?:(?:hey|ok|okay|hi)[\s,]+)/, "");
  if (
    name &&
    request.startsWith(name) &&
    !/[\p{L}\p{N}]/u.test(request.charAt(name.length))
  )
    request = request.slice(name.length).replace(/^[\s,:]+/, "");
  request = request
    .replace(/^(?:(?:please|can you|could you|let me)[\s,]+)+/, "")
    .replace(/[\s,]+please$/, "")
    .replace(/[\s.!?]+$/, "");
  return (
    /^(?:show|list|see)(?:\s+me)?(?:\s+(?:all|all of))?(?:\s+(?:my|the))?(?:\s+open)?(?:\s+browser)?\s+(?:tabs|tab list)(?:\s+(?:i\s+have\s+)?open)?(?:\s+in\s+(?:the\s+)?browser)?$/.test(
      request,
    ) ||
    /^(?:what|which)\s+are\s+my\s+open(?:\s+browser)?\s+tabs$/.test(request) ||
    /^(?:what|which)(?:\s+browser)?\s+tabs\s+(?:do\s+i\s+have|are|have\s+i\s+got)(?:\s+open)?(?:\s+in\s+(?:the\s+)?browser)?$/.test(
      request,
    )
  );
}

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
/** Whether this exact form may be sent: closing every tab is negotiated on its own. */
export function browserControlFormAvailable(
  op: BrowserControlOperation,
  capabilities?: readonly string[],
): boolean {
  return (
    browserControlCapabilityAvailable(op.type, capabilities) &&
    (op.type !== "browser_tab_close" ||
      !op.all ||
      capabilities?.includes(BROWSER_TABS_CLOSE_ALL_CAPABILITY) === true)
  );
}
/** An open tab as the phone lists it on a close-every-tab review card. */
export type BrowserTabLine = {
  title: string;
  host?: string;
  private?: boolean;
};

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
    case "browser_tabs_show":
      allowed([]);
      return { type: value.type };
    case "browser_tab_switch":
      allowed(["target"]);
      return {
        type: value.type,
        target: words(op.target, BROWSER_TAB_TARGET_MAX, "Invalid tab target"),
      };
    case "browser_tab_close":
      allowed(["target", "all"]);
      if (op.all !== undefined && op.all !== true)
        throw Error("Invalid all tabs flag");
      // One tab or every tab: a request for both is refused, never narrowed.
      if (op.all && op.target !== undefined)
        throw Error("Close one named tab or all tabs, not both");
      if (op.all) return { type: value.type, all: true };
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
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
/** The review card: the change itself, nothing else. Closing every tab lists the
 * tabs the phone will close (`closing`, read on the phone, never from the agent);
 * without that list the card says only what will happen. */
export function describeBrowserControl(
  op: BrowserControlOperation,
  closing?: readonly BrowserTabLine[],
): {
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
        // Owner-facing: tool names and arguments belong in the model's tool text.
        description: op.private
          ? "Opens an empty private tab in Browser."
          : "Opens an empty tab in Browser.",
      };
    case "browser_tabs_show":
      return {
        title: "Show open tabs",
        description:
          "Shows the list of your open tabs in Browser. The agent does not see your tabs.",
      };
    case "browser_tab_switch":
      return {
        title: "Switch tab",
        description: `Tab matching ${quoted(op.target)}\n\nYour phone finds the tab. You pick one when more than one matches. The agent does not see your tabs.`,
      };
    case "browser_tab_close":
      if (op.all) {
        const shown = closing?.filter((tab) => !tab.private) ?? [];
        const hidden = (closing?.length ?? 0) - shown.length;
        return closing
          ? {
              title: `Close ${plural(closing.length, "tab")}`,
              description: `${[
                ...shown.map(
                  (tab) =>
                    `• ${tab.title}${tab.host && tab.host !== tab.title ? ` (${tab.host})` : ""}`,
                ),
                ...(hidden ? [`• ${plural(hidden, "private tab")}`] : []),
              ].join(
                "\n",
              )}\n\nCloses every tab listed here. The agent does not see your tabs.`,
            }
          : {
              title: "Close all tabs",
              description:
                "Closes every open tab in Browser. The agent does not see your tabs.",
            };
      }
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
