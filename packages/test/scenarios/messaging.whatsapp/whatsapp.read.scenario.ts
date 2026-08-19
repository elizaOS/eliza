/** Proves recent WhatsApp messages are returned from an exact typed chat fixture. */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
  createStatefulMessageConnectorFixture,
  registerFixtureSeed,
} from "../_fixtures/stateful-message-connector.ts";

const fixture = createStatefulMessageConnectorFixture({
  source: "whatsapp",
  label: "WhatsApp",
  conversations: [
    {
      channelId: "14155550999@s.whatsapp.net",
      label: "Eve",
      kind: "phone",
      messages: [
        {
          id: "wamid.fixture.eve.001",
          sender: "Eve",
          text: "Table is booked under Walters for 7:00 PM.",
          createdAt: Date.parse("2026-08-18T19:00:00.000Z"),
        },
      ],
    },
  ],
});

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "whatsapp.read",
  title: "WhatsApp read returns exact recent chat content",
  domain: "messaging.whatsapp",
  tags: ["messaging", "whatsapp", "typed-fixture", "readback"],
  description:
    "Exercises MESSAGE.read_channel through WhatsApp's typed connector-hook shape and verifies exact JID, message ID, sender, and content. It does not claim a live Meta or Baileys session.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "WhatsApp Read",
    },
  ],
  seed: [registerFixtureSeed(fixture)],
  turns: [
    {
      kind: "action",
      name: "read-eve-whatsapp",
      room: "main",
      text: "Read Eve's latest WhatsApp message.",
      content: {
        metadata: { __responseContext: { primaryContext: "messaging" } },
      },
      actionName: "MESSAGE",
      options: {
        parameters: {
          action: "read_channel",
          source: "whatsapp",
          accountId: "test-owner",
          target: "Eve",
          limit: 5,
        },
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "whatsapp-read-is-bound-to-exact-chat",
      predicate: (ctx) => {
        const blob = JSON.stringify(ctx.actionsCalled);
        return fixture.reads.length === 1 &&
          fixture.reads[0]?.target.channelId === "14155550999@s.whatsapp.net" &&
          blob.includes("wamid.fixture.eve.001") &&
          blob.includes("Table is booked under Walters for 7:00 PM.") &&
          blob.includes("Eve")
          ? undefined
          : `expected exact WhatsApp fixture readback, saw ${JSON.stringify({ reads: fixture.reads, actions: ctx.actionsCalled })}`;
      },
    },
    {
      type: "connectorDispatchOccurred",
      channel: "whatsapp",
      expected: false,
      maxCount: 0,
    },
  ],
});
