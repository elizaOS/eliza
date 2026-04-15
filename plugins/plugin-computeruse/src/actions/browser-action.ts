/**
 * BROWSER_ACTION — CDP browser automation via Puppeteer Core.
 *
 * Controls a Chromium-based browser (Chrome, Edge, Brave) for web automation:
 * opening pages, clicking elements, typing, scrolling, reading DOM,
 * executing JavaScript, and managing tabs.
 *
 * Ported from coasty-ai/open-computer-use browser-automation.ts (Apache 2.0).
 */

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
    "Control a web browser to navigate websites, click elements, fill forms, read page content, " +
    "execute JavaScript, and manage tabs. Uses Chrome DevTools Protocol via Puppeteer Core.\n\n" +
    "Available actions:\n" +
    "- open: Launch browser, optionally navigate to url.\n" +
    "- close: Close the browser.\n" +
    "- navigate: Go to a URL. Requires url.\n" +
    "- click: Click an element by CSS selector, coordinates, or text content.\n" +
    "- type: Type text, optionally into a specific element by selector.\n" +
    "- scroll: Scroll the page up or down. Optional direction and amount (pixels).\n" +
    "- screenshot: Capture the browser viewport as a PNG.\n" +
    "- dom: Get the first 5000 characters of page HTML.\n" +
    "- clickables: List up to 50 interactive elements (links, buttons, inputs) with selectors.\n" +
    "- execute: Run JavaScript code in the page context.\n" +
    "- state: Get the current page URL and title.\n" +
    "- list_tabs: List all open tabs.\n" +
    "- open_tab: Open a new tab, optionally navigate to url.\n" +
    "- close_tab: Close a tab by tabId.\n" +
    "- switch_tab: Switch to a tab by tabId.\n\n" +
    "Start by opening the browser, then navigate and interact. Use 'clickables' to discover interactive elements.",

  parameters: [
    {
      name: "action",
      description: "The browser action to perform",
      required: true,
      schema: {
        type: "string",
        enum: [
          "open", "close", "navigate", "click", "type", "scroll",
          "screenshot", "dom", "clickables", "execute", "state",
          "list_tabs", "open_tab", "close_tab", "switch_tab",
        ],
      },
    },
    {
      name: "url",
      description: "URL for open, navigate, or open_tab actions.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "selector",
      description: "CSS selector to target an element (for click, type).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "coordinate",
      description: "[x, y] coordinates to click in the viewport.",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
    {
      name: "text",
      description: "Text to type, or text content to find and click.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "code",
      description: "JavaScript code to execute in the page context (for execute action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "direction",
      description: "Scroll direction: 'up' or 'down'. Default: 'down'.",
      required: false,
      schema: { type: "string", enum: ["up", "down"] },
    },
    {
      name: "amount",
      description: "Scroll amount in pixels. Default: 300.",
      required: false,
      schema: { type: "number", default: 300 },
    },
    {
      name: "tabId",
      description: "Tab index for switch_tab or close_tab.",
      required: false,
      schema: { type: "string" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Open a browser and go to google.com" },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll open a browser and navigate to Google.", action: "BROWSER_ACTION" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Click the search button on this page." },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll find and click the search button.", action: "BROWSER_ACTION" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What elements can I interact with on this page?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Let me list the clickable elements.", action: "BROWSER_ACTION" },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService("computeruse") as unknown as ComputerUseService | undefined;
    if (!service) return false;
    return service.getCapabilities().browser.available;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const service = runtime.getService("computeruse") as unknown as ComputerUseService | undefined;
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const params = ((options as Record<string, unknown>)?.parameters ?? {}) as BrowserActionParams;

    // Fallback: extract from message content
    if (!params.action && message.content && typeof message.content === "object") {
      const content = message.content as Record<string, unknown>;
      if (content.action) {
        Object.assign(params, content);
      }
    }

    if (!params.action) {
      if (callback) await callback({ text: "No browser action specified." });
      return { success: false, error: "No action specified" };
    }

    const result = await service.executeBrowserAction(params);

    if (callback) {
      if (result.screenshot) {
        await callback({
          text: result.content ?? "Browser screenshot captured.",
          attachments: [
            {
              id: `browser-screenshot-${Date.now()}`,
              url: `data:image/png;base64,${result.screenshot}`,
              title: "Browser Screenshot",
              source: "computeruse",
              description: "Browser viewport capture",
              contentType: "image" as const,
            },
          ],
        });
      } else {
        await callback({
          text: result.success
            ? result.content ?? "Browser action completed."
            : `Browser action failed: ${result.error}`,
        });
      }
    }

    return { success: result.success };
  },
};
