/** Finds available slots and proposes meeting times based on user availability */

import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { SchedulingService } from "../services/scheduling-service.js";
import type { Participant, TimeSlot } from "../types.js";

const parseMeetingRequest = (
  text: string
): {
  title?: string;
  duration?: number;
  urgency?: "flexible" | "soon" | "urgent";
} => {
  const normalized = text.toLowerCase();
  const result: {
    title?: string;
    duration?: number;
    urgency?: "flexible" | "soon" | "urgent";
  } = {};

  // Try to extract a title
  const titleMatch =
    /(?:schedule|book|arrange|set up|plan)\s+(?:a\s+)?(?:meeting|call|chat)\s+(?:about|for|regarding|to discuss)\s+["']?([^"'\n.]+)["']?/i.exec(
      text
    );
  if (titleMatch) {
    result.title = titleMatch[1].trim();
  }

  // Extract duration
  const durationMatch = /(\d+)\s*(?:minute|min|hour|hr)/i.exec(normalized);
  if (durationMatch) {
    let duration = Number.parseInt(durationMatch[1], 10);
    if (normalized.includes("hour") || normalized.includes("hr")) {
      duration *= 60;
    }
    result.duration = duration;
  }

  // Extract urgency
  if (
    normalized.includes("urgent") ||
    normalized.includes("asap") ||
    normalized.includes("immediately")
  ) {
    result.urgency = "urgent";
  } else if (normalized.includes("soon") || normalized.includes("this week")) {
    result.urgency = "soon";
  } else {
    result.urgency = "flexible";
  }

  return result;
};

const formatProposedSlots = (
  slots: Array<{ slot: TimeSlot; score: number; reasons: string[] }>
): string => {
  if (slots.length === 0) {
    return "I couldn't find any available time slots.";
  }

  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };

  const formatted = slots.map((proposal, index) => {
    const start = new Date(proposal.slot.start);
    const end = new Date(proposal.slot.end);

    const formatter = new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: proposal.slot.timeZone,
    });

    const timeFormatter = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: proposal.slot.timeZone,
    });

    const dateStr = formatter.format(start);
    const endTimeStr = timeFormatter.format(end);

    let entry = `${index + 1}. ${dateStr} - ${endTimeStr}`;

    if (proposal.reasons.length > 0) {
      entry += ` (${proposal.reasons[0]})`;
    }

    return entry;
  });

  return `Here are some times that work:\n\n${formatted.join("\n")}\n\nWhich option works best for you? Just say the number.`;
};

export const scheduleMeetingAction: Action = {
  name: "SCHEDULE_MEETING",
  similes: ["BOOK_MEETING", "ARRANGE_MEETING", "SET_UP_MEETING", "PLAN_MEETING", "CREATE_MEETING"],
  description: "Schedule a meeting between multiple participants by finding a suitable time slot",
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text?.toLowerCase() ?? "";
    return (
      text.includes("schedule") ||
      text.includes("book") ||
      text.includes("arrange") ||
      text.includes("set up") ||
      text.includes("plan") ||
      (text.includes("meet") && !text.includes("nice to meet"))
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

    const entityId = message.entityId;
    const roomId = message.roomId;

    if (!entityId || !roomId) {
      await callback?.({
        text: "I could not identify the conversation context. Please try again.",
      });
      return { success: false };
    }

    const text = message.content?.text ?? "";
    const parsed = parseMeetingRequest(text);

    const userAvailability = await schedulingService.getAvailability(entityId);
    if (!userAvailability || userAvailability.weekly.length === 0) {
      await callback?.({
        text: "I don't have your availability yet. Tell me when you're free, e.g. \"weekdays 9am-5pm\"",
      });
      return { success: false };
    }

    const participants: Participant[] = [{ entityId, name: "You", availability: userAvailability }];

    const title = parsed.title || "Meeting";
    const request = await schedulingService.createSchedulingRequest(
      roomId,
      title,
      participants,
      {
        preferredDurationMinutes: parsed.duration || 30,
        maxDaysOut: parsed.urgency === "urgent" ? 3 : parsed.urgency === "soon" ? 7 : 14,
      },
      {
        urgency: parsed.urgency,
      }
    );

    const result = await schedulingService.findAvailableSlots(request);
    if (!result.success || result.proposedSlots.length === 0) {
      await callback?.({
        text: result.failureReason || "No available slots found. Try expanding your availability?",
      });
      return { success: false };
    }

    await callback?.({ text: formatProposedSlots(result.proposedSlots) });

    return {
      success: true,
      data: {
        requestId: request.id,
        proposedSlots: result.proposedSlots,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Can you schedule a meeting for me?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here are some times that work:\n\n1. Mon, Jan 20 at 10:00am - 10:30am (Standard business hours)\n2. Mon, Jan 20 at 2:00pm - 2:30pm (Standard business hours)\n3. Tue, Jan 21 at 9:00am - 9:30am (Preferred time)\n\nWhich option works best for you? Just say the number.",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "I'd like to set up a call for next week" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here are some times that work:\n\n1. Mon, Jan 20 at 10:00am - 10:30am (Standard business hours)\n2. Tue, Jan 21 at 2:00pm - 2:30pm (Preferred day)\n3. Wed, Jan 22 at 11:00am - 11:30am (Standard business hours)\n\nWhich option works best for you? Just say the number.",
        },
      },
    ],
  ],
};
