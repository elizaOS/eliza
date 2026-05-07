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

const AUTO_OPEN_BROWSER_ACTIONS = new Set<BrowserActionParams["action"]>([
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
]);

function shouldAutoOpenBrowser(
  params: BrowserActionParams,
  result: BrowserActionResult,
): boolean {
  return (
    !result.success &&
    typeof result.error === "string" &&
    result.error.includes("Browser not open") &&
    AUTO_OPEN_BROWSER_ACTIONS.has(params.action)
  );
}

async function executeBrowserActionWithAutoOpen(
  service: ComputerUseService,
  params: BrowserActionParams,
): Promise<BrowserActionResult> {
  let result = await service.executeBrowserAction(params);
  if (!shouldAutoOpenBrowser(params, result)) {
    return result;
  }

  const openResult = await service.executeBrowserAction({
    ...params,
    action: "open",
  });
  if (!openResult.success) {
    return openResult;
  }

  result = await service.executeBrowserAction(params);
  return result;
}

export const browserAction: Action = {
  name: "BROWSER_ACTION",
  contexts: ["browser", "automation"],
  contextGate: { anyOf: ["browser", "automation"] },
  roleGate: { minRole: "USER" },
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
    "browser_action:\n  purpose: Control a Chromium-based browser through the local runtime: launch, navigate, interact, inspect, execute JavaScript, wait, and manage tabs.\n  provider_state: Read-only browser availability and recent action state are available from the computerState provider. Use state/info/list_tabs only for explicit live refreshes.\n  flow: Open or connect first, then navigate and interact. Use clickables to discover interactive elements.\n  actions: open/connect/close/navigate/click/type/scroll/screenshot/dom/get_dom/clickables/get_clickables/execute/state/info/context/get_context/wait/list_tabs/open_tab/close_tab/switch_tab.",
  descriptionCompressed:
    "Chromium browser control router: open/connect/navigate/click/type/read dom/clickables/execute/wait/tabs; read-only state.",

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

    const result = await executeBrowserActionWithAutoOpen(service, params);
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
