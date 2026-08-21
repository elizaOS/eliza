/** Proves the canonical MESSAGE read path returns an exact typed iMessage thread. */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
  createStatefulMessageConnectorFixture,
  registerFixtureSeed,
} from "../_fixtures/stateful-message-connector.ts";

const fixture = createStatefulMessageConnectorFixture({
  source: "imessage",
  label: "iMessage",
  accountId: "default",
  conversations: [
    {
      channelId: "chat_id:imessage-family-01",
      label: "Mom",
      kind: "contact",
      messages: [
        {
          id: "imessage-row-5501",
          sender: "Mom",
          text: "Dinner is at 7:15; bring the photo album.",
          createdAt: Date.parse("2026-08-18T18:10:00.000Z"),
        },
      ],
    },
  ],
});

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "imessage.read-incoming",
  title: "iMessage read returns exact incoming thread content",
  domain: "messaging.imessage",
  tags: ["messaging", "imessage", "typed-fixture", "readback"],
  description:
    "Calls MESSAGE.read_channel through the same typed hook shape exposed by IMessageService and asserts the exact chat, platform message ID, sender, and content. This does not claim access to a live macOS chat.db.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "iMessage Read",
    },
  ],
  seed: [registerFixtureSeed(fixture)],
  turns: [
    {
      kind: "action",
      name: "read-mom-imessage",
      room: "main",
      text: "Read Mom's latest iMessage.",
      content: {
        metadata: { __responseContext: { primaryContext: "messaging" } },
      },
      actionName: "MESSAGE",
      options: {
        parameters: {
          action: "read_channel",
          source: "imessage",
          accountId: "default",
          target: "Mom",
          limit: 5,
        },
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "imessage-read-has-exact-chat-and-content",
      predicate: (ctx) => {
        const blob = JSON.stringify(ctx.actionsCalled);
        return fixture.reads.length === 1 &&
          fixture.reads[0]?.target.channelId === "chat_id:imessage-family-01" &&
          blob.includes("imessage-row-5501") &&
          blob.includes("Dinner is at 7:15; bring the photo album.") &&
          blob.includes("Mom")
          ? undefined
          : `expected exact iMessage fixture readback, saw ${JSON.stringify({ reads: fixture.reads, actions: ctx.actionsCalled })}`;
      },
    },
    {
      type: "connectorDispatchOccurred",
      channel: "imessage",
      expected: false,
      maxCount: 0,
    },
  ],
});
