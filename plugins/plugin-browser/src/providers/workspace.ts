/**
 * Browser workspace provider — surfaces the live browser-workspace tab list
 * and current dispatch mode (`desktop` / `web`) into agent context whenever
 * a `browser` or `web` context is selected.
 *
 * Does not include wallet state; an agent that needs wallet context gets it
 * from the wallet provider instead of coupling it to browser workspace state.
 */

import type { Provider } from "@elizaos/core";
import {
  getBrowserWorkspaceMode,
  listBrowserWorkspaceTabs,
} from "../workspace/browser-workspace.js";

const PROVIDER_NAME = "browser_workspace";
const MAX_TABS_IN_SUMMARY = 8;

export const browserWorkspaceProvider: Provider = {
  name: PROVIDER_NAME,
  description:
    "Live summary of the Eliza browser workspace — current dispatch mode and the open tab list, capped to the first 8 tabs.",
  descriptionCompressed: "Browser workspace mode + open tab list.",
  contexts: ["browser", "web"],
  contextGate: { anyOf: ["browser", "web"] },
  cacheStable: false,
  cacheScope: "turn",
  // Live browser workspace (dispatch mode + open tabs/URLs) is owner-operator
  // context (#12094 item 3: gate travels with the provider so a rename can't
  // silently drop it).
  roleGate: { minRole: "OWNER" },
  get: async () => {
    try {
      const mode = getBrowserWorkspaceMode();
      const tabs = await listBrowserWorkspaceTabs();
      const text = JSON.stringify(
        {
          [PROVIDER_NAME]: {
            mode,
            tabCount: tabs.length,
            tabs: tabs.slice(0, MAX_TABS_IN_SUMMARY).map((tab) => ({
              id: tab.id,
              visible: tab.visible,
              url: tab.url,
              title: tab.title,
            })),
          },
        },
        null,
        2,
      );
      return {
        text,
        data: {
          available: true,
          mode,
          tabs,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: JSON.stringify(
          {
            [PROVIDER_NAME]: {
              available: false,
              error: message,
            },
          },
          null,
          2,
        ),
        data: { available: false, error: message },
      };
    }
  },
};
