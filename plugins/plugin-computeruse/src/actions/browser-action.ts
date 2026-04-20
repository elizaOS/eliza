import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { BrowserActionParams } from "../types.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import {
  buildScreenshotAttachment,
  resolveActionParams,
} from "./helpers.js";

export const browserAction: Action = {
  name: "BROWSER_ACTION",
  similes: [
    "CONTROL_BROWSER",
    "WEB_BROWSER",
    "OPEN_BROWSER",
    "BROWSE_WEB",
    "NAVIGATE_BROWSER",
    "BROWSER_CLICK",
    "BROWSER_TYPE",
  ],
  description:
    "Control a Chromium-based browser through the local runtime. This action opens or connects to a browser session, navigates pages, clicks elements, types into forms, reads DOM state, executes JavaScript, waits for conditions, and manages tabs.\n\n" +
    "Available actions:\n" +
    "- open / connect: start or attach to the browser, optionally at a URL.\n" +
    "- close: close the browser.\n" +
    "- navigate: visit a URL.\n" +
    "- click: click by selector, viewport coordinate, or visible text.\n" +
    "- type: type text, optionally targeting a selector.\n" +
    "- scroll: scroll the page.\n" +
    "- screenshot: capture the browser viewport.\n" +
    "- dom / get_dom: return page HTML.\n" +
    "- clickables / get_clickables: list likely interactive elements.\n" +
    "- execute: run JavaScript in the page context.\n" +
    "- state / info / context: inspect browser state.\n" +
    "- wait: wait for a selector, text, or timeout.\n" +
    "- list_tabs / open_tab / close_tab / switch_tab: manage tabs.\n\n" +
    "Why this exists: it gives the agent structured browser control without requiring raw desktop coordinates for every web interaction.",
  descriptionCompressed: "Browser control: navigate, click, type, scroll, screenshot, DOM, JS exec, tabs.",
  parameters: [
    {
      name: "action",
      description: "Browser action to perform.",
      required: true,
      schema: {
        type: "string",
        enum: [
          "open",
          "connect",
          "close",
          "navigate",
          "click",
          "type",
          "scroll",
          "screenshot",
          "dom",
          "get_dom",
          "clickables",
          "get_clickables",
          "execute",
          "state",
          "info",
          "context",
          "wait",
          "list_tabs",
          "open_tab",
          "close_tab",
          "switch_tab",
        ],
      },
    },
    {
      name: "url",
      description: "URL for open, navigate, or open_tab.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "selector",
      description: "CSS selector for click, type, or wait.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "coordinate",
      description: "Viewport [x, y] coordinate for click.",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
    {
      name: "text",
      description: "Text to type, text to click, or text to wait for.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "code",
      description: "JavaScript source to execute in the page.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "direction",
      description: "Scroll direction.",
      required: false,
      schema: { type: "string", enum: ["up", "down"] },
    },
    {
      name: "amount",
      description: "Scroll amount in pixels.",
      required: false,
      schema: { type: "number", default: 300 },
    },
    {
      name: "tabId",
      description: "Tab identifier for tab actions.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "tab_index",
      description: "Upstream alias for tabId/index.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "index",
      description: "Upstream alias for tabId/tab_index.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "timeout",
      description: "Timeout in milliseconds for wait.",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    return !!service && service.getCapabilities().browser.available;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const params = resolveActionParams<BrowserActionParams>(message, options);
    if (!params.action) {
      if (callback) {
        await callback({ text: "No browser action specified." });
      }
      return { success: false, error: "No action specified" };
    }

    const result = await service.executeBrowserAction(params);

    if (callback) {
      await callback({
        text: result.success
          ? result.content ?? result.message ?? "Browser action completed."
          : `Browser action failed: ${result.error}`,
        ...(result.screenshot
          ? {
              attachments: [
                buildScreenshotAttachment({
                  idPrefix: "browser-screenshot",
                  screenshot: result.screenshot,
                  title: "Browser Screenshot",
                  description: "Browser viewport capture",
                }),
              ],
            }
          : {}),
      });
    }

    return result as unknown as any;
  },
};
