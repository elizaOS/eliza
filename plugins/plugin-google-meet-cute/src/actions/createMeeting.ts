import {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  HandlerCallback,
  State,
  logger,
  ActionExample,
} from "@elizaos/core";
import { GoogleMeetAPIService } from "../services/googleMeetAPIService";
import { CreateMeetingParams } from "../types";

export const createMeetingAction: Action = {
  name: "CREATE_MEETING",
  description: "Create a new Google Meet meeting space",
  descriptionCompressed: "create new Google Meet meet space",
  similes: ["start a meeting", "create a meet", "new meeting", "setup a call"],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Create a new meeting",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll create a new Google Meet meeting for you.",
          action: "CREATE_MEETING",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Start a team meeting with restricted access",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll create a restricted access meeting for your team.",
          action: "CREATE_MEETING",
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    const googleMeetService = runtime.getService(
      "google-meet-api",
    ) as GoogleMeetAPIService;

    if (!googleMeetService) {
      logger.error("Google Meet API service not found");
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    params?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const googleMeetService = runtime.getService(
        "google-meet-api",
      ) as GoogleMeetAPIService;

      if (!googleMeetService) {
        throw new Error("Google Meet API service not found");
      }

      const meetingParams = params as CreateMeetingParams | undefined;

      // Parse access type from message if not provided
      let accessType = meetingParams?.accessType;
      if (!accessType && message.content.text) {
        const text = message.content.text.toLowerCase();
        if (text.includes("restricted") || text.includes("private")) {
          accessType = "RESTRICTED";
        } else if (text.includes("trusted") || text.includes("organization")) {
          accessType = "TRUSTED";
        } else {
          accessType = "OPEN";
        }
      }

      const meeting = await googleMeetService.createMeeting({
        accessType,
      });

      const response = `✅ Meeting created successfully!

📅 **Meeting Details:**
- Meeting Link: ${meeting.meetingUri}
- Meeting Code: ${meeting.meetingCode}
- Access Type: ${accessType}
- Status: Active

You can share this link with participants to join the meeting.`;

      if (callback) {
        await callback({
          text: response,
          metadata: {
            meetingId: meeting.id,
            meetingUri: meeting.meetingUri,
            meetingCode: meeting.meetingCode,
          },
        });
      }
      return {
        success: true,
        text: response,
        data: {
          actionName: "CREATE_MEETING",
          meetingId: meeting.id,
          meetingUri: meeting.meetingUri,
          meetingCode: meeting.meetingCode,
          accessType,
        },
      };
    } catch (error) {
      logger.error(
        "Failed to create meeting:",
        error instanceof Error ? error.message : String(error),
      );

      const text = `Failed to create meeting: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
      if (callback) {
        await callback({
          text,
          error: true,
        });
      }
      return {
        success: false,
        text,
        data: { actionName: "CREATE_MEETING" },
      };
    }
  },
};
