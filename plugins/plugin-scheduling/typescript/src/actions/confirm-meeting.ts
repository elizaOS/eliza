/**
 * @module confirm-meeting
 * @description Action for confirming or declining meeting attendance
 */

import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { SchedulingService } from "../services/scheduling-service.js";

export const confirmMeetingAction: Action = {
  name: "CONFIRM_MEETING",
  similes: [
    "ACCEPT_MEETING",
    "CONFIRM_ATTENDANCE",
    "RSVP_YES",
    "DECLINE_MEETING",
    "CANCEL_ATTENDANCE",
  ],
  description: "Confirm or decline attendance for a scheduled meeting",
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text?.toLowerCase() ?? "";
    return (
      (text.includes("confirm") && text.includes("meeting")) ||
      (text.includes("accept") && text.includes("meeting")) ||
      (text.includes("decline") && text.includes("meeting")) ||
      text.includes("rsvp") ||
      text.includes("i'll be there") ||
      text.includes("i can't make it")
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const schedulingService = runtime.getService<SchedulingService>("SCHEDULING");
    if (!schedulingService) {
      await callback?.({
        text: "Scheduling service is not available. Please try again later.",
      });
      return { success: false };
    }

    const text = message.content?.text?.toLowerCase() ?? "";
    const isConfirming =
      text.includes("confirm") ||
      text.includes("accept") ||
      text.includes("i'll be there") ||
      text.includes("yes");

    // Get upcoming meetings for this user
    const meetings = await schedulingService.getUpcomingMeetings(message.entityId);

    if (meetings.length === 0) {
      await callback?.({
        text: "You don't have any upcoming meetings to confirm.",
      });
      return { success: false };
    }

    // For now, handle the most recent proposed meeting
    const pendingMeetings = meetings.filter((m) => m.status === "proposed");
    if (pendingMeetings.length === 0) {
      await callback?.({
        text: "All your upcoming meetings have already been confirmed.",
      });
      return { success: true };
    }

    const meeting = pendingMeetings[0];

    if (isConfirming) {
      await schedulingService.confirmParticipant(meeting.id, message.entityId);
      const formattedTime = schedulingService.formatSlot(meeting.slot);
      await callback?.({
        text: `Great! I've confirmed your attendance for "${meeting.title}" on ${formattedTime}. You'll receive a calendar invite shortly.`,
      });
    } else {
      await schedulingService.declineParticipant(
        meeting.id,
        message.entityId,
        "User declined via chat"
      );
      await callback?.({
        text: `I've noted that you can't make it to "${meeting.title}". I'll let the other participants know and see if we can find another time.`,
      });
    }

    return { success: true };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Yes, I'll be there for the meeting" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Great! I've confirmed your attendance for \"Coffee Chat\" on Mon, Jan 20, 10:00 AM - 11:00 AM. You'll receive a calendar invite shortly.",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "I can't make the meeting, something came up" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I've noted that you can't make it to \"Coffee Chat\". I'll let the other participants know and see if we can find another time.",
        },
      },
    ],
  ],
};
