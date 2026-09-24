/** Defines the complete planner and human authority catalog for Messages view interactions. */

import type { ViewCapability } from "@elizaos/core";

export const MESSAGES_VIEW_CAPABILITIES: ViewCapability[] = [
  {
    id: "list-threads",
    description:
      "List the complete Android SMS conversation-thread set and role state.",
    authority: "agent",
  },
  {
    id: "send-sms",
    description: "Send an SMS message through the Android Messages bridge.",
    authority: "human",
    params: {
      address: {
        type: "string",
        description: "Recipient phone number or SMS address.",
        required: true,
        minLength: 1,
      },
      body: {
        type: "string",
        description: "Message body.",
        required: true,
        minLength: 1,
      },
    },
  },
  {
    id: "request-sms-role",
    description: "Ask Android to make Eliza the default SMS role holder.",
    authority: "human",
  },
  {
    id: "get-state",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic message read.",
    authority: "human",
  },
  {
    id: "get-text",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic message read.",
    authority: "human",
  },
  {
    id: "list-elements",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic message read.",
    authority: "human",
  },
  {
    id: "describe-element",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic message read.",
    authority: "human",
  },
  {
    id: "get-focus",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic message read.",
    authority: "human",
  },
  {
    id: "get-agent-state",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic message read.",
    authority: "human",
  },
];

export type MessagesViewCapabilityId =
  | "list-threads"
  | "send-sms"
  | "request-sms-role";
