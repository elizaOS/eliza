/** Proves an exact WhatsApp payload reaches the connector only after owner confirmation. */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
  createStatefulMessageConnectorFixture,
  registerFixtureSeed,
  registerUnknownEntityResolutionSeed,
} from "../_fixtures/stateful-message-connector.ts";

const fixture = createStatefulMessageConnectorFixture({
  source: "whatsapp",
  label: "WhatsApp",
  conversations: [
    {
      channelId: "14155550999@s.whatsapp.net",
      recipientId: "+14155550999",
      label: "Eve",
      kind: "contact",
      messages: [
        {
          id: "wamid.fixture.eve.latest",
          sender: "Eve",
          text: "Still good for tonight?",
          createdAt: Date.parse("2026-08-18T19:05:00.000Z"),
        },
      ],
    },
  ],
});

const sendParameters = {
  action: "send",
  source: "whatsapp",
  accountId: "test-owner",
  target: "Eve",
  targetKind: "contact",
  message: "See you at 7.",
  persist: false,
};

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "whatsapp.reply",
  title: "WhatsApp reply dispatches exact payload after confirmation",
  domain: "messaging.whatsapp",
  tags: ["messaging", "whatsapp", "confirmation", "dispatch-receipt"],
  description:
    "Runs the real MESSAGE recipient-confirmation gate against a stateful WhatsApp connector fixture and verifies one exact E.164 target, payload, and provider-style receipt after approval.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "WhatsApp Reply",
    },
  ],
  seed: [
    registerFixtureSeed(fixture),
    registerUnknownEntityResolutionSeed("See you at 7."),
  ],
  turns: [
    {
      kind: "action",
      name: "request-whatsapp-send",
      room: "main",
      text: "Send Eve a WhatsApp message saying see you at 7.",
      content: {
        metadata: { __responseContext: { primaryContext: "messaging" } },
      },
      actionName: "MESSAGE",
      options: { parameters: sendParameters },
      assertTurn: () =>
        fixture.dispatches.length === 0
          ? undefined
          : "WhatsApp dispatched before explicit approval",
    },
    {
      kind: "action",
      name: "confirm-whatsapp-send",
      room: "main",
      text: "Yes, send that exact WhatsApp message now.",
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
      channel: "whatsapp",
      turn: "request-whatsapp-send",
      expected: false,
      maxCount: 0,
    },
    {
      type: "connectorDispatchOccurred",
      channel: "whatsapp",
      turn: "confirm-whatsapp-send",
      minCount: 1,
      maxCount: 1,
    },
    {
      type: "custom",
      name: "whatsapp-send-is-exact-and-receipted",
      predicate: (ctx) => {
        const dispatch = fixture.dispatches[0];
        const observed = ctx.connectorDispatches?.filter(
          (entry) => entry.channel === "whatsapp",
        );
        return fixture.dispatches.length === 1 &&
          dispatch?.target.entityId === "+14155550999" &&
          dispatch.content.text === "See you at 7." &&
          observed?.length === 1 &&
          observed[0]?.delivered === true &&
          observed[0]?.providerMessageIds?.[0] === dispatch.providerMessageId
          ? undefined
          : `expected one exact delivered WhatsApp dispatch, saw ${JSON.stringify({ fixture: fixture.dispatches, observed })}`;
      },
    },
  ],
});
