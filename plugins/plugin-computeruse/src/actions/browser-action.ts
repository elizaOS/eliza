import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { BrowserActionParams, BrowserActionResult } from "../types.js";
import {
  buildScreenshotAttachment,
  resolveActionParams,
  toComputerUseActionResult,
} from "./helpers.js";

function formatBrowserResultText(result: BrowserActionResult): string {
  return result.success
    ? (result.content ?? "Browser action completed.")
    : result.permissionDenied
      ? `Browser action failed because ${result.permissionType} permission is missing.`
      : result.approvalRequired
        ? `Browser action is waiting for approval (${result.approvalId}).`
        : `Browser action failed: ${result.error}`;
}

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
    "- open: Launch browser, optionally navigate to url.\n" +
    "- connect: Alias for open.\n" +
    "- close: Close the browser.\n" +
    "- navigate: Go to a URL. Requires url.\n" +
    "- click: Click an element by CSS selector, coordinates, or text content.\n" +
    "- type: Type text, optionally into a specific element by selector.\n" +
    "- scroll: Scroll the page up or down. Optional direction and amount (pixels).\n" +
    "- screenshot: Capture the browser viewport as a PNG.\n" +
    "- dom: Get the first 5000 characters of page HTML.\n" +
    "- get_dom: Alias for dom.\n" +
    "- clickables: List up to 50 interactive elements (links, buttons, inputs) with selectors.\n" +
    "- get_clickables: Alias for clickables.\n" +
    "- execute: Run JavaScript code in the page context.\n" +
    "- state: Get the current page URL and title.\n" +
    "- info: Report whether the browser is open and its current page metadata.\n" +
    "- context/get_context: Alias for the current page URL and title.\n" +
    "- wait: Wait for a selector or text to appear.\n" +
    "- list_tabs: List all open tabs.\n" +
    "- open_tab: Open a new tab, optionally navigate to url.\n" +
    "- close_tab: Close a tab by tabId.\n" +
    "- switch_tab: Switch to a tab by tabId.\n\n" +
    "Start by opening the browser, then navigate and interact. Use 'clickables' to discover interactive elements.",

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
          "get_context",
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
      name: "timeout",
      description: "Timeout in milliseconds for wait actions.",
      required: false,
      schema: { type: "number", default: 5000 },
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
  ): Promise<ActionResult> => {
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
    const text = formatBrowserResultText(result);

    if (callback) {
      if (result.screenshot) {
        await callback({
          text:
            result.content ??
            (params.action === "screenshot"
              ? "Browser screenshot captured."
              : text),
          attachments: [
            buildScreenshotAttachment({
              idPrefix: "browser-screenshot",
              screenshot: result.screenshot,
              title: "Browser Screenshot",
              description: "Browser viewport capture",
            }),
          ],
        });
      } else {
        await callback({ text });
      }
    }

    return toComputerUseActionResult({
      action: params.action,
      result,
      text,
    });
  },
};
