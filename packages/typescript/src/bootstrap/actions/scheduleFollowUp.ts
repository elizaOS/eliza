import { findEntityByName } from "../../entities.ts";
import { logger } from "../../logger.ts";
import type { FollowUpService } from "../../services/followUp.ts";
import type { RolodexService } from "../../services/rolodex.ts";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import { asUUID, ModelType } from "../../types/index.ts";
import { composePromptFromState, parseKeyValueXml } from "../../utils.ts";

interface ScheduleFollowUpXmlResult {
  contactName?: string;
  entityId?: string;
  scheduledAt?: string;
  reason?: string;
  priority?: string;
  message?: string;
}

const scheduleFollowUpTemplate = `# Schedule Follow-up

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the follow-up scheduling information from the message:
1. Who to follow up with (name or entity reference)
2. When to follow up (date/time or relative time like "tomorrow", "next week")
3. Reason for the follow-up
4. Priority (high, medium, low)
5. Any specific message or notes

## Current Date/Time
{{currentDateTime}}

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to follow up with</contactName>
<entityId>ID if known, otherwise leave empty</entityId>
<scheduledAt>ISO datetime for the follow-up</scheduledAt>
<reason>Reason for the follow-up</reason>
<priority>high, medium, or low</priority>
<message>Optional message or notes for the follow-up</message>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const scheduleFollowUpAction: Action = {
  name: "SCHEDULE_FOLLOW_UP",
  description: "Schedule a follow-up reminder for a contact",
  similes: [
    "follow up with",
    "remind me to contact",
    "schedule a check-in",
    "set a reminder for",
    "follow up on",
    "check back with",
    "reach out to",
    "schedule follow-up",
    "remind me about",
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Remind me to follow up with John next week about the project",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've scheduled a follow-up with John for next week about the project.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Schedule a follow-up with Sarah tomorrow at 2pm" },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've scheduled a follow-up with Sarah for tomorrow at 2:00 PM.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Follow up with the VIP client in 3 days" },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've scheduled a follow-up with the VIP client in 3 days.",
        },
      },
    ],
  ],

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

    const followUpKeywords = [
      "follow up",
      "followup",
      "remind",
      "check in",
      "check back",
      "reach out",
      "schedule",
    ];
    const messageText = message.content.text?.toLowerCase() || "";

    return followUpKeywords.some((keyword) => messageText.includes(keyword));
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
    });

    const parsedResponse =
      parseKeyValueXml<ScheduleFollowUpXmlResult>(response);
    if (
      !parsedResponse ||
      (!parsedResponse.contactName && !parsedResponse.entityId)
    ) {
      logger.warn(
        "[ScheduleFollowUp] Failed to parse follow-up information from response",
      );
      throw new Error("Could not extract follow-up information");
    }

    let entityId = parsedResponse.entityId
      ? asUUID(parsedResponse.entityId)
      : null;

    if (!entityId && parsedResponse.contactName) {
      const entity = await findEntityByName(runtime, message, state);

      if (entity?.id) {
        entityId = entity.id;
      } else {
        throw new Error(
          `Contact "${parsedResponse.contactName}" not found in rolodex`,
        );
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

    logger.info(
      `[ScheduleFollowUp] Scheduled follow-up for ${parsedResponse.contactName} at ${scheduledAt.toISOString()}`,
    );

    const responseText = `I've scheduled a follow-up with ${parsedResponse.contactName} for ${scheduledAt.toLocaleString()}. ${
      parsedResponse.reason ? `Reason: ${parsedResponse.reason}` : ""
    }`;

    if (callback) {
      await callback({
        text: responseText,
        action: "SCHEDULE_FOLLOW_UP",
        metadata: {
          contactId: entityId,
          contactName: parsedResponse.contactName,
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
        contactName: parsedResponse.contactName ?? "",
        scheduledAt: scheduledAt.toISOString(),
        taskId: task.id ?? "",
        reason: parsedResponse.reason ?? "",
        priority: parsedResponse.priority ?? "medium",
      },
      text: responseText,
    };
  },
};
