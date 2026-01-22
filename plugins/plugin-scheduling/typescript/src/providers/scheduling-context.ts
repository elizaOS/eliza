/**
 * @module scheduling-context
 * @description Provider that gives the agent context about scheduling state
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { SchedulingService } from "../services/scheduling-service.js";
import type { Meeting } from "../types.js";

/**
 * Format a meeting for display in context
 */
const formatMeetingForContext = (meeting: Meeting, service: SchedulingService): string => {
  const timeStr = service.formatSlot(meeting.slot);
  const participants = meeting.participants.map((p) => p.name).join(", ");
  const locationStr =
    meeting.location.type === "in_person"
      ? `at ${meeting.location.name}`
      : meeting.location.type === "virtual"
        ? "virtual meeting"
        : "phone call";

  return `- "${meeting.title}" on ${timeStr} (${locationStr}) with ${participants} [${meeting.status}]`;
};

export const schedulingContextProvider: Provider = {
  name: "SCHEDULING_CONTEXT",
  description: "Provides context about upcoming meetings and scheduling requests",
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const schedulingService = runtime.getService<SchedulingService>("SCHEDULING");
    if (!schedulingService) {
      return { text: "" };
    }

    const entityId = message.entityId;
    if (!entityId) {
      return { text: "" };
    }

    const sections: string[] = [];

    try {
      const meetings = await schedulingService.getUpcomingMeetings(entityId);

      if (meetings.length > 0) {
        const proposedMeetings = meetings.filter((m) => m.status === "proposed");
        const confirmedMeetings = meetings.filter(
          (m) => m.status === "confirmed" || m.status === "scheduled"
        );

        if (proposedMeetings.length > 0) {
          sections.push("Meetings pending confirmation:");
          for (const meeting of proposedMeetings.slice(0, 3)) {
            sections.push(formatMeetingForContext(meeting, schedulingService));
          }
        }

        if (confirmedMeetings.length > 0) {
          sections.push("\nUpcoming confirmed meetings:");
          for (const meeting of confirmedMeetings.slice(0, 5)) {
            sections.push(formatMeetingForContext(meeting, schedulingService));
          }
        }
      }

      const availability = await schedulingService.getAvailability(entityId);
      if (availability) {
        const weeklyCount = availability.weekly.length;
        const exceptionsCount = availability.exceptions.length;

        sections.push(
          `\nUser has ${weeklyCount} recurring availability windows set (timezone: ${availability.timeZone})`
        );
        if (exceptionsCount > 0) {
          sections.push(`User has ${exceptionsCount} availability exceptions`);
        }
      } else {
        sections.push("\nUser has not set their availability yet");
      }
    } catch {
      // Silently fail if storage not ready
    }

    if (sections.length === 0) {
      return { text: "" };
    }

    return { text: `<scheduling_context>\n${sections.join("\n")}\n</scheduling_context>` };
  },
};
