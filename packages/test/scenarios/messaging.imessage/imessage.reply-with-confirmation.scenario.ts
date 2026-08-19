/** Proves an exact iMessage payload reaches the connector only after owner confirmation. */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
  createStatefulMessageConnectorFixture,
  registerFixtureSeed,
  registerUnknownEntityResolutionSeed,
} from "../_fixtures/stateful-message-connector.ts";

const fixture = createStatefulMessageConnectorFixture({
  source: "imessage",
  label: "iMessage",
  accountId: "default",
  conversations: [
    {
      channelId: "chat_id:imessage-mom-01",
      recipientId: "+14155550177",
      label: "Mom",
      kind: "contact",
      messages: [
        {
          id: "imessage-row-mom-latest",
          sender: "Mom",
          text: "Can you call tonight?",
          createdAt: Date.parse("2026-08-18T18:15:00.000Z"),
        },
      ],
    },
  ],
});

const sendParameters = {
  action: "send",
  source: "imessage",
  accountId: "default",
  target: "Mom",
  targetKind: "contact",
  message: "I'll call after dinner.",
  persist: false,
};

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "imessage.reply-with-confirmation",
  title: "iMessage reply dispatches only after explicit confirmation",
  domain: "messaging.imessage",
  tags: ["messaging", "imessage", "confirmation", "dispatch-receipt"],
  description:
    "Runs the canonical MESSAGE recipient-confirmation gate against an iMessage-shaped connector fixture, then checks one exact phone target, payload, and provider receipt after approval.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "iMessage Reply",
    },
  ],
  seed: [
    registerFixtureSeed(fixture),
    registerUnknownEntityResolutionSeed("I'll call after dinner."),
  ],
  turns: [
    {
      kind: "action",
      name: "request-imessage-send",
      room: "main",
      text: "Send Mom an iMessage saying I'll call after dinner.",
      content: {
        metadata: { __responseContext: { primaryContext: "messaging" } },
      },
      actionName: "MESSAGE",
      options: { parameters: sendParameters },
      assertTurn: () =>
        fixture.dispatches.length === 0
          ? undefined
          : "iMessage dispatched before explicit approval",
    },
    {
      kind: "action",
      name: "confirm-imessage-send",
      room: "main",
      text: "Yes, send that exact iMessage now.",
      content: {
        metadata: { __responseContext: { primaryContext: "messaging" } },
      },
      actionName: "MESSAGE",
      options: { parameters: sendParameters },
    },
  ],
  finalChecks: [
    {
      type: "connectorDispatchOccurred",
      channel: "imessage",
      turn: "request-imessage-send",
      expected: false,
      maxCount: 0,
    },
    {
      type: "connectorDispatchOccurred",
      channel: "imessage",
      turn: "confirm-imessage-send",
      minCount: 1,
      maxCount: 1,
    },
    {
      type: "custom",
      name: "imessage-send-is-exact-and-receipted",
      predicate: (ctx) => {
        const dispatch = fixture.dispatches[0];
        const observed = ctx.connectorDispatches?.filter(
          (entry) => entry.channel === "imessage",
        );
        return fixture.dispatches.length === 1 &&
          dispatch?.target.entityId === "+14155550177" &&
          dispatch.content.text === "I'll call after dinner." &&
          observed?.length === 1 &&
          observed[0]?.delivered === true &&
          observed[0]?.providerMessageIds?.[0] === dispatch.providerMessageId
          ? undefined
          : `expected one exact delivered iMessage, saw ${JSON.stringify({ fixture: fixture.dispatches, observed })}`;
      },
    },
  ],
});
