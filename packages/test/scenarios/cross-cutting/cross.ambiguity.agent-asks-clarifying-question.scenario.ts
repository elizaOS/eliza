/**
 * Ambiguity handling: the user asks to "Message John" while the Rolodex
 * contains three different Johns. The agent must ask a clarifying question
 * before sending anything. MESSAGE firing is a hard failure.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "cross.ambiguity.agent-asks-clarifying-question",
  title: "Ambiguous contact name triggers a clarifying question",
  domain: "cross-cutting",
  tags: ["cross-cutting", "ambiguity", "happy-path"],
  description:
    "Three seeded contacts named John. The user says 'Message John'. The agent must ask which John — not pick one silently or fire MESSAGE.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: ambiguity",
    },
  ],

  seed: [
    {
      type: "contact",
      name: "John Smith",
      handles: [{ platform: "telegram", identifier: "@johnsmith" }],
    },
    {
      type: "contact",
      name: "John Doe",
      handles: [{ platform: "telegram", identifier: "@johndoe" }],
    },
    {
      type: "contact",
      name: "John Chen",
      handles: [{ platform: "telegram", identifier: "@johnchen" }],
    },
  ],

  turns: [
    {
      kind: "message",
      name: "ambiguous-message-john",
      room: "main",
      text: "Message John",
      forbiddenActions: ["MESSAGE"],
      responseIncludesAny: [
        "which",
        "Which",
        "disambiguate",
        "John Smith",
        "John Doe",
        "John Chen",
        /clarif/i,
        /specif/i,
        /who.*mean/i,
        /more than one/i,
        /multiple/i,
        /full name/i,
        /last name/i,
        "?",
      ],
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REPLY",
      minCount: 1,
    },
  ],
});
