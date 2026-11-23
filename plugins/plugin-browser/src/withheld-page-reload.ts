import {
  browserDestinationMatches,
  directBrowserDestination,
  withheldBrowserPageReloadRefusal,
} from "@elizaos/contracts/browser-request-grounding";
import { readClientBrowserPage } from "@elizaos/contracts/client-turn-observation";
import {
  extractUserText,
  type Memory,
  unwrapUserMessageText,
} from "@elizaos/core";

// Agent-side policy. It lives apart from native-client-command.ts, which a
// client renderer also loads and which must not import the agent core.

const OPEN_SUBACTIONS = ["open", "navigate", "show"];
// The same page: scheme, host, path and query; a fragment loads nothing new.
function samePage(url: string, page: string): boolean {
  try {
    const a = new URL(url),
      b = new URL(page);
    a.hash = "";
    b.hash = "";
    return a.href === b.href;
  } catch {
    return false;
  }
}

/**
 * Why a native reload, or an open of the very page that is showing, must not
 * run: the Browser page this turn carried was withheld (the phone could not
 * read it, or shares no text from it) and the owner's own message did not ask
 * for a reload or explicitly ask to open that address. Reloading never makes the page readable
 * and can resubmit a form. Undefined when the command may run.
 */
export function withheldPageReloadRefusal(
  message: { content: unknown },
  command: { subaction: string; url?: string },
  assistantName?: string,
): string | undefined {
  const content = message.content;
  if (!content || typeof content !== "object" || Array.isArray(content))
    return undefined;
  const page = readClientBrowserPage(
    (content as Record<string, unknown>).metadata,
  );
  if (!page?.withheld) return undefined;
  const reopen =
    OPEN_SUBACTIONS.includes(command.subaction) &&
    command.url !== undefined &&
    samePage(command.url, page.url);
  if (command.subaction !== "reload" && !reopen) return undefined;
  const ownerText = extractUserText(unwrapUserMessageText(message as Memory));
  if (reopen)
    return browserDestinationMatches(
      { type: "browser_navigate", url: command.url },
      directBrowserDestination(ownerText, assistantName),
    )
      ? undefined
      : withheldBrowserPageReloadRefusal(page, "");
  return withheldBrowserPageReloadRefusal(page, ownerText);
}
