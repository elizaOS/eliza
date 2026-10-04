import type { ActionParameter } from "@elizaos/core";

export const LIFEOPS_BENCHMARK_TOOL_ACTION_NAMES = [
  "CALENDAR",
  "CALENDAR_CREATE_EVENT",
  "CALENDAR_UPDATE_EVENT",
  "CALENDAR_DELETE_EVENT",
  "CALENDAR_SEARCH_EVENTS",
  "CALENDAR_CHECK_AVAILABILITY",
  "CALENDAR_PROPOSE_TIMES",
  "CALENDAR_NEXT_EVENT",
  "CALENDAR_UPDATE_PREFERENCES",
  "MESSAGE",
  "MESSAGE_SEND",
  "MESSAGE_DRAFT_REPLY",
  "MESSAGE_MANAGE",
  "MESSAGE_TRIAGE",
  "MESSAGE_SEARCH_INBOX",
  "MESSAGE_LIST_CHANNELS",
  "MESSAGE_READ_CHANNEL",
  "MESSAGE_READ_WITH_CONTACT",
  "ARCHIVE_EMAIL_THREAD",
  "ARCHIVE_THREAD",
] as const;

export const LIFEOPS_BENCHMARK_TOOL_PARAMETERS: ActionParameter[] = [
  {
    name: "subaction",
    description: "Calendar/Entity subaction, such as check_availability.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "operation",
    description: "Message/Money operation, such as manage or search_inbox.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "action",
    description: "Alias for subaction or operation.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "source",
    description: "LifeOps source, for example gmail, slack, imessage.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "manageOperation",
    description: "Message manage operation, such as archive or mark_read.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "threadId",
    description: "Email/chat thread id.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "thread_id",
    description: "Email/chat thread id alias.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "messageId",
    description: "Email/chat message id.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "message_id",
    description: "Email/chat message id alias.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "eventId",
    description: "Calendar event id.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "calendarId",
    description: "Calendar id.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "title",
    description: "Calendar event title or message title.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "query",
    description: "Search query.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "folder",
    description: "Mail folder, such as inbox.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "startAt",
    description: "ISO-8601 calendar availability start time.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "endAt",
    description: "ISO-8601 calendar availability end time.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "start",
    description: "ISO-8601 calendar start time alias.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "end",
    description: "ISO-8601 calendar end time alias.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "body",
    description: "Email/message body.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "text",
    description: "Chat/message text.",
    required: false,
    schema: { type: "string" },
  },
  {
    name: "details",
    description:
      "Nested LifeOps action details. Prefer top-level fields when the tool manifest asks for them.",
    required: false,
    schema: {
      type: "object",
      additionalProperties: true,
    },
  },
  {
    name: "intent",
    description: "Short natural-language intent for the LifeOps action.",
    required: false,
    schema: { type: "string" },
  },
];

export function lifeOpsBenchmarkToolDescription(name: string): string {
  if (name === "ARCHIVE_EMAIL_THREAD" || name === "ARCHIVE_THREAD") {
    return "LifeOpsBench email archive alias. Use for Gmail/email thread archive requests with threadId.";
  }
  if (name.startsWith("MESSAGE")) {
    return (
      "LifeOpsBench MESSAGE tool for email, inbox, Gmail, chat, and thread " +
      "requests. Use for archive, mark_read, triage, search_inbox, " +
      "draft_reply, send, list_channels, read_channel, and read_with_contact."
    );
  }
  if (name.startsWith("CALENDAR")) {
    return (
      "LifeOpsBench CALENDAR tool for calendar events and availability. Use " +
      "for create_event, update_event, delete_event, search_events, " +
      "check_availability, propose_times, next_event, and update_preferences."
    );
  }
  return "LifeOpsBench action. Captures a planner-emitted LifeOps tool call for the benchmark fake backend.";
}
