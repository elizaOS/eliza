/**
 * v609 Alpha image, "text 415-555-0100 saying ...": the planner searched
 * DISCOVER_ACTIONS for "send text message SMS to phone contact", the query
 * named the messaging and phone domains, and the search was scoped to them.
 * PROPOSE_DEVICE_ACTION (contexts general and contacts, empty summary) was not
 * in that scope, so only VOICE_CALL, PAGE_DELEGATE and a Maps read came back.
 */
import type { Action } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../device-actions/service.ts", async (original) => ({
  ...(await original<typeof import("../device-actions/service.ts")>()),
  getDeviceActionTurn: () => undefined,
}));

import { proposeDeviceAction } from "../device-actions/action.ts";
import {
  actionDiscoveryContexts,
  inferActionSearchContexts,
  retrieveContextualPlannerActions,
} from "./action-surface";

// The other tools the planner saw for that query, by their routing fields.
const voiceCall = {
  name: "VOICE_CALL",
  description: "Owner-only outbound voice call via Twilio.",
  descriptionCompressed:
    "Twilio voice dial: recipientKind=owner|external|e164; draft, owner yes/no next turn",
  contexts: ["contacts", "messaging", "phone", "tasks", "automation"],
  similes: ["CALL_ME", "PHONE_SOMEONE", "DIAL"],
  parameters: [],
  validate: async () => true,
  handler: async () => undefined,
} as unknown as Action;
const actions = [proposeDeviceAction, voiceCall];

function discover(query: string): string[] {
  const contexts = inferActionSearchContexts(actions, query);
  const scoped = contexts.length
    ? actions.filter((action) =>
        actionDiscoveryContexts(action).some((context) =>
          contexts.includes(context),
        ),
      )
    : actions;
  return retrieveContextualPlannerActions({
    actions: scoped,
    query,
    contexts: contexts.length ? contexts : undefined,
  }).actions.map((action) => action.name);
}

describe("phone telephony discovery", () => {
  it("finds the phone's own reviewed operations for a text, a call and the dialer", () => {
    for (const query of [
      "send text message SMS to phone contact",
      "call phone number",
      "open the phone dialer keypad",
      "show my phone contacts",
    ])
      expect(discover(query), query).toContain("PROPOSE_DEVICE_ACTION");
  });
});
