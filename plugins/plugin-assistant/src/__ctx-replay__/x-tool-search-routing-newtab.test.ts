/** Local measurement only (not committed): which browser tools the planner bootstrap picks for "Open a new tab." */
import { writeFileSync } from "node:fs";
import type { Action } from "@elizaos/core";
import { it } from "vitest";
import { deviceActionTools } from "../services/device-actions/tools";
import { retrieveContextualPlannerActions } from "../services/message/action-surface";

const OUT = process.env.CTX_TSR_OUT;

it.skipIf(!OUT)("browser bootstrap for a new-tab request", () => {
  const browser = (deviceActionTools as readonly Action[]).filter((action) =>
    action.name.startsWith("DEVICE_BROWSER_"),
  );
  const run = (label: string, actions: readonly Action[], query: string, intents: string[]) => {
    const picked = retrieveContextualPlannerActions({
      actions,
      deferUnscopedBootstrap: true,
      query,
      intents,
      contexts: ["browser"],
    });
    return { label, query, offered: actions.map((a) => a.name), picked: picked.actions.map((a) => a.name), matchCount: picked.matchCount, deferred: picked.deferredCount };
  };
  const withSimiles = browser.map((action) =>
    action.name === "DEVICE_BROWSER_TAB_NEW"
      ? { ...action, similes: [...(action.similes ?? []), "new tab", "open a new tab", "open a tab"] }
      : action,
  );
  const rows = [
    ["Open a new tab.", ["open a new browser tab"]],
    ["Open a new tab.", ["Open a new browser tab"]],
    ["new tab", ["open a new tab"]],
    ["Open a private tab.", ["open a private browser tab"]],
    ["Close this tab.", ["close the current browser tab"]],
    ["Switch to the example.com tab.", ["switch to the example.com tab"]],
    ['Find "refund" on this page.', ['Find "refund" on the current browser page']],
    ["Open example.com.", ["open example.com in the browser"]],
    ["Search the web for flights to Lisbon.", ["search the web for flights to Lisbon"]],
  ].flatMap(([query, intents]) => [
    run("as written", browser, query as string, intents as string[]),
    run("with similes on DEVICE_BROWSER_TAB_NEW", withSimiles, query as string, intents as string[]),
  ]);
  writeFileSync(OUT as string, JSON.stringify({ similes: Object.fromEntries(browser.map((a) => [a.name, a.similes])), contexts: Object.fromEntries(browser.map((a) => [a.name, a.contexts])), rows }, null, 1));
});
