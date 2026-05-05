import {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  HandlerCallback,
  State,
  logger,
} from "@elizaos/core";
import { GoogleMeetAPIService } from "../services/googleMeetAPIService";

export const getParticipantsAction: Action = {
  name: "GET_PARTICIPANTS",
  description: "Get the list of participants in a Google Meet conference",
  descriptionCompressed: "get list participant Google Meet conference",
  similes: [
    "who's in the meeting",
    "list participants",
    "attendees",
    "who joined",
  ],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Who's in the meeting?",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll check who's currently in the meeting.",
          action: "GET_PARTICIPANTS",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "List all participants",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Let me get the participant list for you.",
          action: "GET_PARTICIPANTS",
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

      const options =
        params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const text = typeof message.content?.text === "string" ? message.content.text : "";
      const conferenceRecordName =
        typeof options.conferenceRecordName === "string"
          ? options.conferenceRecordName
          : text.match(/conferenceRecords\/[A-Za-z0-9_-]+/)?.[0];

      const currentMeeting = conferenceRecordName
        ? null
        : googleMeetService.getCurrentMeeting();
      const participants = conferenceRecordName
        ? await googleMeetService.listParticipants(conferenceRecordName)
        : currentMeeting?.participants;
      if (!participants) {
        throw new Error(
          "No active meeting found. Provide conferenceRecordName to list participants from a finished conference.",
        );
      }

      const response = `👥 **Meeting Participants:**

${
  participants.length === 0
    ? "No participants have joined yet."
    : participants
        .map((p, index) => {
          const status = p.isActive ? "🟢" : "⚫";
          const duration = p.leaveTime
            ? `(${Math.round((p.leaveTime.getTime() - p.joinTime.getTime()) / 1000 / 60)} min)`
            : "(active)";
          return `${index + 1}. ${status} ${p.name} - Joined at ${p.joinTime.toLocaleTimeString()} ${duration}`;
        })
        .join("\n")
}

**Total participants:** ${participants.length}
**Currently active:** ${participants.filter((p) => p.isActive).length}`;

      if (callback) {
        await callback({
          text: response,
          metadata: {
            totalParticipants: participants.length,
            activeParticipants: participants.filter((p) => p.isActive).length,
            participants: participants.map((p) => ({
              name: p.name,
              isActive: p.isActive,
              joinTime: p.joinTime.toISOString(),
            })),
          },
        });
      }
      return {
        success: true,
        text: response,
        data: {
          actionName: "GET_PARTICIPANTS",
          conferenceRecordName,
          totalParticipants: participants.length,
          activeParticipants: participants.filter((p) => p.isActive).length,
        },
      };
    } catch (error) {
      logger.error(
        "Failed to get participants:",
        error instanceof Error ? error.message : String(error),
      );

      const text = `Failed to get participants: ${
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
        data: { actionName: "GET_PARTICIPANTS" },
      };
    }
  },
};
