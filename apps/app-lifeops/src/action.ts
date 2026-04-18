import { hasAdminAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type {
  CompleteLifeOpsBrowserSessionRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  LifeOpsBrowserActionKind,
  LifeOpsBrowserKind,
  UpdateLifeOpsBrowserSettingsRequest,
} from "@elizaos/shared/contracts/lifeops";
import { LifeOpsService, LifeOpsServiceError } from "./lifeops/service.js";

type BrowserCommand =
  | "get_settings"
  | "update_settings"
  | "list_companions"
  | "list_tabs"
  | "read_current_page"
  | "list_sessions"
  | "get_session"
  | "confirm_session"
  | "complete_session"
  | "open"
  | "navigate"
  | "focus_tab"
  | "back"
  | "forward"
  | "reload"
  | "click"
  | "type"
  | "submit"
  | "read_page"
  | "extract_links"
  | "extract_forms";

type BrowserParams = {
  command?: BrowserCommand;
  title?: string;
  sessionId?: string;
  browser?: LifeOpsBrowserKind;
  companionId?: string;
  profileId?: string;
  windowId?: string;
  tabId?: string;
  url?: string;
  selector?: string;
  text?: string;
  confirmed?: boolean;
  accountAffecting?: boolean;
  requiresConfirmation?: boolean;
  settings?: UpdateLifeOpsBrowserSettingsRequest;
  result?: Record<string, unknown>;
  status?: CompleteLifeOpsBrowserSessionRequest["status"];
};

const URL_RE = /https?:\/\/[^\s)]+/i;

function getMessageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function inferCommandFromMessage(text: string): BrowserCommand | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  if (/\b(browser settings|lifeops browser settings)\b/.test(normalized)) {
    return "get_settings";
  }
  if (/\b(list|show).*(tabs)\b/.test(normalized)) {
    return "list_tabs";
  }
  if (/\b(current page|read page|what page)\b/.test(normalized)) {
    return "read_current_page";
  }
  if (/\bextract\b.*\blinks\b/.test(normalized)) {
    return "extract_links";
  }
  if (/\bextract\b.*\bforms\b/.test(normalized)) {
    return "extract_forms";
  }
  if (/\bfocus\b.*\btab\b/.test(normalized)) {
    return "focus_tab";
  }
  if (/\bback\b/.test(normalized)) {
    return "back";
  }
  if (/\bforward\b/.test(normalized)) {
    return "forward";
  }
  if (/\breload\b|\brefresh\b/.test(normalized)) {
    return "reload";
  }
  if (/\bclick\b/.test(normalized)) {
    return "click";
  }
  if (/\btype\b/.test(normalized)) {
    return "type";
  }
  if (/\bsubmit\b/.test(normalized)) {
    return "submit";
  }
  if (
    URL_RE.test(normalized) &&
    /\b(open|navigate|go to|goto)\b/.test(normalized)
  ) {
    return /\bopen\b/.test(normalized) ? "open" : "navigate";
  }
  return null;
}

function commandToActionKind(
  command: BrowserCommand,
): LifeOpsBrowserActionKind {
  switch (command) {
    case "open":
    case "navigate":
    case "focus_tab":
    case "back":
    case "forward":
    case "reload":
    case "click":
    case "type":
    case "submit":
    case "read_page":
    case "extract_links":
    case "extract_forms":
      return command;
    default:
      throw new Error(`Unsupported browser command ${command}`);
  }
}

function actionLabel(command: BrowserCommand, params: BrowserParams): string {
  if (params.title?.trim()) {
    return params.title.trim();
  }
  switch (command) {
    case "open":
      return "Open URL in personal browser";
    case "navigate":
      return "Navigate current tab";
    case "focus_tab":
      return "Focus browser tab";
    case "read_page":
      return "Read the current page";
    case "extract_links":
      return "Extract page links";
    case "extract_forms":
      return "Extract page forms";
    default:
      return `LifeOps Browser ${command.replace(/_/g, " ")}`;
  }
}

function sessionSummary(
  session: Awaited<ReturnType<LifeOpsService["createBrowserSession"]>>,
): string {
  const target = [session.browser, session.profileId, session.tabId]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join("/");
  return `Created LifeOps Browser session "${session.title}" (${session.status})${target ? ` for ${target}` : ""}.`;
}

async function runCommand(
  runtime: IAgentRuntime,
  params: BrowserParams,
): Promise<ActionResult> {
  const service = new LifeOpsService(runtime);
  const command = params.command;
  if (!command) {
    return {
      success: false,
      text: "MANAGE_LIFEOPS_BROWSER requires a command.",
      data: { error: "INVALID_COMMAND" },
    };
  }

  switch (command) {
    case "get_settings": {
      const settings = await service.getBrowserSettings();
      return {
        success: true,
        text: `LifeOps Browser settings: ${settings.enabled ? settings.trackingMode : "off"}; control ${settings.allowBrowserControl ? "enabled" : "disabled"}.`,
        data: { settings },
      };
    }
    case "update_settings": {
      const settings = await service.updateBrowserSettings(
        params.settings ?? {},
      );
      return {
        success: true,
        text: `Updated LifeOps Browser settings: ${settings.enabled ? settings.trackingMode : "off"}; control ${settings.allowBrowserControl ? "enabled" : "disabled"}.`,
        data: { settings },
      };
    }
    case "list_companions": {
      const companions = await service.listBrowserCompanions();
      return {
        success: true,
        text:
          companions.length === 0
            ? "No LifeOps Browser companions are paired."
            : `LifeOps Browser companions:\n${companions
                .map(
                  (companion) =>
                    `- ${companion.browser}/${companion.profileLabel || companion.profileId}: ${companion.connectionState}`,
                )
                .join("\n")}`,
        data: { companions },
      };
    }
    case "list_tabs": {
      const tabs = await service.listBrowserTabs();
      return {
        success: true,
        text:
          tabs.length === 0
            ? "No remembered LifeOps Browser tabs are available."
            : `Remembered LifeOps Browser tabs:\n${tabs
                .map((tab) => `- ${tab.title}: ${tab.url}`)
                .join("\n")}`,
        data: { tabs },
      };
    }
    case "read_current_page": {
      const page = await service.getCurrentBrowserPage();
      return {
        success: true,
        text: page
          ? `Current LifeOps Browser page: ${page.title} ${page.url}`
          : "No current LifeOps Browser page is available.",
        data: { page },
      };
    }
    case "list_sessions": {
      const sessions = await service.listBrowserSessions();
      return {
        success: true,
        text:
          sessions.length === 0
            ? "No LifeOps Browser sessions exist."
            : `LifeOps Browser sessions:\n${sessions
                .slice(0, 8)
                .map(
                  (session) =>
                    `- ${session.id}: ${session.title} (${session.status})`,
                )
                .join("\n")}`,
        data: { sessions },
      };
    }
    case "get_session": {
      if (!params.sessionId) {
        return {
          success: false,
          text: "get_session requires sessionId.",
          data: { error: "MISSING_SESSION_ID" },
        };
      }
      const session = await service.getBrowserSession(params.sessionId);
      return {
        success: true,
        text: `${session.title}: ${session.status}`,
        data: { session },
      };
    }
    case "confirm_session": {
      if (!params.sessionId) {
        return {
          success: false,
          text: "confirm_session requires sessionId.",
          data: { error: "MISSING_SESSION_ID" },
        };
      }
      const request: ConfirmLifeOpsBrowserSessionRequest = {
        confirmed: params.confirmed ?? false,
      };
      const session = await service.confirmBrowserSession(
        params.sessionId,
        request,
      );
      return {
        success: true,
        text: `${session.title}: ${session.status}`,
        data: { session },
      };
    }
    case "complete_session": {
      if (!params.sessionId) {
        return {
          success: false,
          text: "complete_session requires sessionId.",
          data: { error: "MISSING_SESSION_ID" },
        };
      }
      const request: CompleteLifeOpsBrowserSessionRequest = {
        status: params.status,
        result: params.result,
      };
      const session = await service.completeBrowserSession(
        params.sessionId,
        request,
      );
      return {
        success: true,
        text: `${session.title}: ${session.status}`,
        data: { session },
      };
    }
    default: {
      const actionKind = commandToActionKind(command);
      const request: CreateLifeOpsBrowserSessionRequest = {
        title: params.title?.trim() || actionLabel(command, params),
        browser: params.browser ?? null,
        companionId: params.companionId ?? null,
        profileId: params.profileId ?? null,
        windowId: params.windowId ?? null,
        tabId: params.tabId ?? null,
        actions: [
          {
            kind: actionKind,
            label: actionLabel(command, params),
            browser: params.browser ?? null,
            windowId: params.windowId ?? null,
            tabId: params.tabId ?? null,
            url: params.url ?? null,
            selector: params.selector ?? null,
            text: params.text ?? null,
            accountAffecting: params.accountAffecting ?? command === "submit",
            requiresConfirmation: params.requiresConfirmation ?? false,
            metadata: {},
          },
        ],
      };
      const session = await service.createBrowserSession(request);
      return {
        success: true,
        text: sessionSummary(session),
        data: { session },
      };
    }
  }
}

export const manageLifeOpsBrowserAction: Action = {
  name: "MANAGE_LIFEOPS_BROWSER",
  similes: ["PERSONAL_BROWSER", "LIFEOPS_BROWSER", "MANAGE_PERSONAL_BROWSER"],
  description:
    "Read and control the user's real Chrome and Safari browsers connected through LifeOps Browser. This is not Milady Desktop Browser.",
  validate: async (runtime, message) => hasAdminAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options?: HandlerOptions,
  ): Promise<ActionResult> => {
    if (!(await hasAdminAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner or admins may use LifeOps Browser control.",
        data: { error: "PERMISSION_DENIED" },
      };
    }

    const rawParams = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as BrowserParams;
    const inferredCommand =
      rawParams.command ?? inferCommandFromMessage(getMessageText(message));
    const params: BrowserParams = {
      ...rawParams,
      command: inferredCommand ?? rawParams.command,
      url: rawParams.url ?? getMessageText(message).match(URL_RE)?.[0],
    };

    try {
      return await runCommand(runtime, params);
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        return {
          success: false,
          text: error.message,
          data: { error: error.message, status: error.status },
        };
      }
      throw error;
    }
  },
  parameters: [
    {
      name: "command",
      description:
        "Browser command: get_settings, update_settings, list_companions, list_tabs, read_current_page, list_sessions, get_session, confirm_session, complete_session, or a browser control command.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "url",
      description: "Target URL for open or navigate commands.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "selector",
      description: "DOM selector for click, type, or submit commands.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "text",
      description: "Input text for type commands.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sessionId",
      description:
        "Browser session id for get_session, confirm_session, or complete_session.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "settings",
      description: "Settings payload for update_settings.",
      required: false,
      schema: { type: "object" as const },
    },
  ],
};
