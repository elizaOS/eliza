/** Proves Discord-local recent-message reads against a typed, stateful connector fixture. */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
  createStatefulMessageConnectorFixture,
  registerFixtureSeed,
} from "../_fixtures/stateful-message-connector.ts";

const fixture = createStatefulMessageConnectorFixture({
  source: "discord-local",
  label: "Discord Local",
  conversations: [
    {
      channelId: "dm-bob-001",
      label: "Bob",
      kind: "contact",
      messages: [
        {
          id: "discord-msg-001",
          sender: "Bob",
          text: "The rehearsal moved to Studio B at 6:30.",
          createdAt: Date.parse("2026-08-18T16:30:00.000Z"),
        },
      ],
    },
  ],
});

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "discord.local.read-recent",
  title: "Discord-local reads exact recent DM content",
  domain: "messaging.discord-local",
  tags: ["messaging", "discord", "typed-fixture", "durable-readback"],
  description:
    "Calls the canonical MESSAGE read operation through a stateful MessageConnector fixture and verifies the exact typed Discord DM returned by the connector hook. This deterministic contract does not claim a live Discord connection.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Discord Local Read",
    },
  ],
  seed: [registerFixtureSeed(fixture)],
  turns: [
    {
      kind: "action",
      name: "read-discord-dm",
      room: "main",
      text: "Read Bob's recent Discord DM.",
      content: {
        metadata: { __responseContext: { primaryContext: "messaging" } },
      },
      actionName: "MESSAGE",
      options: {
        parameters: {
          action: "read_channel",
          source: "discord-local",
          accountId: "test-owner",
          target: "Bob",
          limit: 5,
        },
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "discord-read-is-bound-to-exact-thread-and-message",
      predicate: (ctx) => {
        const blob = JSON.stringify(ctx.actionsCalled);
        if (fixture.reads.length !== 1) {
          return `expected one connector read, saw ${fixture.reads.length}`;
        }
        if (fixture.reads[0]?.target.channelId !== "dm-bob-001") {
          return `expected dm-bob-001 target, saw ${JSON.stringify(fixture.reads[0])}`;
        }
        return blob.includes("discord-msg-001") &&
          blob.includes("The rehearsal moved to Studio B at 6:30.")
          ? undefined
          : `expected exact typed Discord message in action data, saw ${blob}`;
      },
    },
    {
      type: "connectorDispatchOccurred",
      channel: "discord-local",
      expected: false,
      maxCount: 0,
    },
  ],
});
