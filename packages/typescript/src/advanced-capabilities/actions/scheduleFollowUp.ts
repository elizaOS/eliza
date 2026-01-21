import { findEntityByName } from "../../entities.ts";
import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import { scheduleFollowUpTemplate } from "../../prompts.ts";
import type { FollowUpService } from "../../services/followUp.ts";
import type { RolodexService } from "../../services/rolodex.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import { asUUID, ModelType } from "../../types/index.ts";
import { composePromptFromState, parseKeyValueXml } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("SCHEDULE_FOLLOW_UP");
const FOLLOW_UP_KEYWORDS = [
  "follow up",
  "followup",
  "remind",
  "check in",
  "check back",
  "reach out",
  "schedule",
];

interface ScheduleFollowUpXmlResult {
  contactName?: string;
  entityId?: string;
  scheduledAt?: string;
  reason?: string;
  priority?: string;
  message?: string;
}

export const scheduleFollowUpAction: Action = {
  name: spec.name,
  description: spec.description,
  similes: spec.similes ? [...spec.similes] : [],
  examples: (spec.examples ?? []) as ActionExample[][],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const rolodexService = runtime.getService("rolodex") as RolodexService;
    const followUpService = runtime.getService("follow_up") as FollowUpService;

    if (!rolodexService || !followUpService) {
      logger.warn("[ScheduleFollowUp] Required services not available");
      return false;
    }

    const messageText = message.content.text?.toLowerCase() || "";
    if (!messageText) return false;
    return FOLLOW_UP_KEYWORDS.some((keyword) => messageText.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const rolodexService = runtime.getService("rolodex") as RolodexService;
    const followUpService = runtime.getService("follow_up") as FollowUpService;

    if (!rolodexService || !followUpService) {
      throw new Error("Required services not available");
    }

    if (!state) {
      state = {
        values: {},
        data: {},
        text: "",
      };
    }

    state.values = {
      ...state.values,
      message: message.content.text,
      senderId: message.entityId,
      senderName: state.values?.senderName || "User",
      currentDateTime: new Date().toISOString(),
    };

    const prompt = composePromptFromState({
      state,
      template: scheduleFollowUpTemplate,
    });

    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    const parsedResponse =
      parseKeyValueXml<ScheduleFollowUpXmlResult>(response);
    const contactName = parsedResponse?.contactName?.trim();
    if (!parsedResponse || (!contactName && !parsedResponse.entityId)) {
      logger.warn(
        "[ScheduleFollowUp] Failed to parse follow-up information from response",
      );
      throw new Error("Could not extract follow-up information");
    }

    let entityId = parsedResponse.entityId
      ? asUUID(parsedResponse.entityId)
      : null;

    if (!entityId && contactName) {
      const entity = await findEntityByName(runtime, message, state);

      if (entity?.id) {
        entityId = entity.id;
      } else {
        throw new Error(`Contact "${contactName}" not found in rolodex`);
      }
    }

    if (!entityId) {
      throw new Error("Could not determine contact to follow up with");
    }

    const contact = await rolodexService.getContact(entityId);
    if (!contact) {
      throw new Error("Contact not found in rolodex. Please add them first.");
    }

    const scheduledAt = new Date(parsedResponse.scheduledAt || "");
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new Error("Invalid follow-up date/time");
    }

    const task = await followUpService.scheduleFollowUp(
      entityId,
      scheduledAt,
      parsedResponse.reason || "Follow-up",
      (parsedResponse.priority as "high" | "medium" | "low") || "medium",
      parsedResponse.message,
    );

    const resolvedContactName = contactName || "contact";
    logger.info(
      `[ScheduleFollowUp] Scheduled follow-up for ${resolvedContactName} at ${scheduledAt.toISOString()}`,
    );

    const responseText = `I've scheduled a follow-up with ${resolvedContactName} for ${scheduledAt.toLocaleString()}. ${
      parsedResponse.reason ? `Reason: ${parsedResponse.reason}` : ""
    }`;

    if (callback) {
      await callback({
        text: responseText,
        action: "SCHEDULE_FOLLOW_UP",
        metadata: {
          contactId: entityId,
          contactName: resolvedContactName,
          scheduledAt: scheduledAt.toISOString(),
          taskId: task.id,
          success: true,
        },
      });
    }

    return {
      success: true,
      values: {
        contactId: entityId,
        taskId: task.id ?? "",
      },
      data: {
        contactId: entityId,
        contactName: resolvedContactName,
        scheduledAt: scheduledAt.toISOString(),
        taskId: task.id ?? "",
        reason: parsedResponse.reason ?? "",
        priority: parsedResponse.priority ?? "medium",
      },
      text: responseText,
    };
  },
};
