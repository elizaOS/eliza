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
import { deviceActionTools } from "../device-actions/tools.ts";
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

function discover(query: string, from: readonly Action[] = actions): string[] {
  const contexts = inferActionSearchContexts(from, query);
  const scoped = contexts.length
    ? from.filter((action) =>
        actionDiscoveryContexts(action).some((context) =>
          contexts.includes(context),
        ),
      )
    : from;
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

  // Every DEVICE_* tool spread PROPOSE_DEVICE_ACTION, telephony summary
  // included, so the phone-context Maps selected-place read outranked the
  // call/dialer operation for these queries; the read also carried the
  // telephony "phone" context and its call/dial keyword signals.
  it("ranks the telephony operation ahead of any unrelated device tool", () => {
    const all = [proposeDeviceAction, voiceCall, ...deviceActionTools];
    for (const query of ["call phone number", "open the phone dialer keypad"]) {
      const found = discover(query, all);
      expect(found[0], query).toBe("PROPOSE_DEVICE_ACTION");
    }
  });
  it("keeps each device tool's own summary rather than the parent's", () => {
    const parent = proposeDeviceAction.descriptionCompressed;
    expect(parent).toBeTruthy();
    for (const tool of deviceActionTools)
      expect(tool.descriptionCompressed, tool.name).not.toBe(parent);
  });
});
