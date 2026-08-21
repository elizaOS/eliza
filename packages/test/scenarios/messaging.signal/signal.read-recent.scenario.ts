/** Proves recent Signal messages are returned from an exact typed conversation fixture. */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
  createStatefulMessageConnectorFixture,
  registerFixtureSeed,
} from "../_fixtures/stateful-message-connector.ts";

const fixture = createStatefulMessageConnectorFixture({
  source: "signal",
  label: "Signal",
  conversations: [
    {
      channelId: "+14155550888",
      label: "Dana",
      kind: "phone",
      messages: [
        {
          id: "signal-1724002200000",
          sender: "Dana",
          text: "The cabin booking is confirmed for September 12.",
          createdAt: Date.parse("2026-08-18T18:50:00.000Z"),
        },
      ],
    },
  ],
});

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "signal.read-recent",
  title: "Signal read returns exact recent message content",
  domain: "messaging.signal",
  tags: ["messaging", "signal", "typed-fixture", "readback"],
  description:
    "Exercises MESSAGE.read_channel through Signal's typed connector-hook shape and verifies exact recipient, message ID, sender, and content. It does not claim a live signal-cli session.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Signal Read",
    },
  ],
  seed: [registerFixtureSeed(fixture)],
  turns: [
    {
      kind: "action",
      name: "read-dana-signal",
      room: "main",
      text: "Read Dana's latest Signal message.",
      content: {
        metadata: { __responseContext: { primaryContext: "messaging" } },
      },
      actionName: "MESSAGE",
      options: {
        parameters: {
          action: "read_channel",
          source: "signal",
          accountId: "test-owner",
          target: "Dana",
          limit: 5,
        },
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "signal-read-is-bound-to-exact-conversation",
      predicate: (ctx) => {
        const blob = JSON.stringify(ctx.actionsCalled);
        return fixture.reads.length === 1 &&
          fixture.reads[0]?.target.channelId === "+14155550888" &&
          blob.includes("signal-1724002200000") &&
          blob.includes("The cabin booking is confirmed for September 12.") &&
          blob.includes("Dana")
          ? undefined
          : `expected exact Signal fixture readback, saw ${JSON.stringify({ reads: fixture.reads, actions: ctx.actionsCalled })}`;
      },
    },
    {
      type: "connectorDispatchOccurred",
      channel: "signal",
      expected: false,
      maxCount: 0,
    },
  ],
});
