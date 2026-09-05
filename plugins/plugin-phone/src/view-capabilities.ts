/** Defines the complete planner and human authority catalog for Phone view interactions. */

import type { ViewCapability } from "@elizaos/core";

export const PHONE_VIEW_CAPABILITIES = [
  {
    id: "phone-state",
    description: "Read Android phone status and recent calls.",
    authority: "agent",
    params: {
      number: {
        type: "string",
        description: "Optional phone-number filter.",
      },
    },
  },
  {
    id: "place-call",
    description: "Place an outbound phone call.",
    authority: "human",
    params: {
      number: {
        type: "string",
        description: "Phone number to call.",
        required: true,
        minLength: 1,
      },
    },
  },
  {
    id: "open-dialer",
    description: "Open the Android dialer, optionally with a number.",
    authority: "human",
    params: {
      number: {
        type: "string",
        description: "Optional phone number to prefill.",
      },
    },
  },
  {
    id: "save-call-transcript",
    description: "Persist an agent transcript and optional summary for a call.",
    authority: "human",
    params: {
      callId: {
        type: "string",
        description: "Call-log record identifier.",
        required: true,
        minLength: 1,
      },
      transcript: {
        type: "string",
        description: "Complete call transcript.",
        required: true,
        minLength: 1,
      },
      summary: {
        type: "string",
        description: "Optional call summary.",
      },
    },
  },
  {
    id: "get-state",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic phone read.",
    authority: "human",
  },
  {
    id: "get-text",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic phone read.",
    authority: "human",
  },
  {
    id: "list-elements",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic phone read.",
    authority: "human",
  },
  {
    id: "describe-element",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic phone read.",
    authority: "human",
  },
  {
    id: "get-focus",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic phone read.",
    authority: "human",
  },
  {
    id: "get-agent-state",
    description:
      "Inspect renderer-owned state or elements outside the complete semantic phone read.",
    authority: "human",
  },
] satisfies ViewCapability[];

export type PhoneViewCapabilityId =
  | "phone-state"
  | "place-call"
  | "open-dialer"
  | "save-call-transcript";
