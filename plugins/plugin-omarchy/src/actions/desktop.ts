/**
 * Planner actions for bounded Omarchy presentation operations. Status is
 * read-only; notification and pill presentation accept explicit user intent
 * only and delegate to the fixed-command bridge.
 */
import type {
  Action,
  ActionResult,
  HandlerOptions,
  Memory,
} from "@elizaos/core";
import {
  isOmarchyHost,
  type NotificationUrgency,
  type OmarchyBridge,
  omarchyBridge,
} from "../bridge.js";

function parameter(
  options: HandlerOptions | undefined,
  name: string,
): string | undefined {
  const value = options?.parameters?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function failure(error: unknown): ActionResult {
  return {
    success: false,
    text: error instanceof Error ? error.message : String(error),
  };
}

export function createOmarchyDesktopActions(
  bridge: OmarchyBridge = omarchyBridge,
  hostCheck: () => boolean = isOmarchyHost,
): Action[] {
  const statusAction: Action = {
    name: "GET_OMARCHY_STATUS",
    description:
      "Read the current Omarchy version, theme, shell plugin inventory, and Eliza shell-plugin state.",
    descriptionCompressed: "Read Omarchy desktop status.",
    tags: ["capability:read"],
    validate: async () => hostCheck(),
    handler: async (): Promise<ActionResult> => {
      const snapshot = await bridge.snapshot();
      if (!snapshot.available) {
        return {
          success: false,
          text: "Omarchy is unavailable on this runtime.",
          data: snapshot,
        };
      }
      const enabled =
        snapshot.plugins?.filter((plugin) => plugin.enabled) ?? [];
      return {
        success: true,
        text: `Omarchy ${snapshot.version ?? "unknown"} is running${snapshot.theme ? ` with the ${snapshot.theme} theme` : ""}; ${enabled.length} shell plugins are enabled.`,
        data: snapshot,
      };
    },
  };

  const notifyAction: Action = {
    name: "SHOW_OMARCHY_NOTIFICATION",
    description:
      "Show a local Omarchy desktop notification only when the user explicitly asks for a notification or desktop alert. Requires headline and body. Does not attach a click command.",
    descriptionCompressed: "Show an explicitly requested Omarchy notification.",
    tags: ["capability:send"],
    roleGate: { minRole: "USER" },
    parameters: [
      {
        name: "headline",
        description: "Short notification headline (maximum 120 characters).",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 120 },
      },
      {
        name: "body",
        description: "Notification body (maximum 500 characters).",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 500 },
      },
      {
        name: "urgency",
        description: "Notification urgency.",
        required: false,
        schema: { type: "string", enum: ["low", "normal", "critical"] },
      },
    ],
    validate: async (_runtime, message: Memory) =>
      hostCheck() &&
      /\b(notify|notification|desktop alert|show (?:me )?an? alert)\b/i.test(
        message.content.text ?? "",
      ),
    handler: async (
      _runtime,
      _message,
      _state,
      options,
    ): Promise<ActionResult> => {
      const headline = parameter(options, "headline");
      const body = parameter(options, "body");
      const requestedUrgency = parameter(options, "urgency");
      if (!headline || !body) {
        return {
          success: false,
          text: "SHOW_OMARCHY_NOTIFICATION requires headline and body parameters.",
        };
      }
      const urgency: NotificationUrgency = [
        "low",
        "normal",
        "critical",
      ].includes(requestedUrgency ?? "")
        ? (requestedUrgency as NotificationUrgency)
        : "normal";
      try {
        await bridge.notify(headline, body, urgency);
        return {
          success: true,
          text: `Displayed the Omarchy notification “${headline}”.`,
          userFacingText: `Displayed “${headline}”.`,
        };
      } catch (error) {
        // error-policy:J1 action boundary translates a typed command failure
        // into the planner's structured failure path.
        return failure(error);
      }
    },
  };

  const showPillAction: Action = {
    name: "SHOW_ELIZA_OMARCHY_PILL",
    description:
      "Open the local Eliza quick-chat pill in Omarchy only when the user explicitly asks to show or open it.",
    descriptionCompressed: "Open the Eliza Omarchy pill on explicit request.",
    tags: ["capability:send"],
    roleGate: { minRole: "USER" },
    validate: async (_runtime, message: Memory) =>
      hostCheck() &&
      /\b(open|show|summon)\b.*\b(eliza|quick[ -]?chat)\b.*\b(pill|overlay|panel|quick[ -]?chat)\b/i.test(
        message.content.text ?? "",
      ),
    handler: async (): Promise<ActionResult> => {
      try {
        await bridge.showElizaPill();
        return {
          success: true,
          text: "Opened the Eliza quick-chat pill in Omarchy.",
          userFacingText: "Opened Eliza quick chat.",
        };
      } catch (error) {
        // error-policy:J1 action boundary translates a typed command failure
        // into the planner's structured failure path.
        return failure(error);
      }
    },
  };

  return [statusAction, notifyAction, showPillAction];
}

export const omarchyDesktopActions = createOmarchyDesktopActions();
