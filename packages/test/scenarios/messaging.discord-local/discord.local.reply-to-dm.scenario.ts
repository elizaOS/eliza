/** Proves an exact Discord-local DM payload is dispatched only after owner confirmation. */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
  createStatefulMessageConnectorFixture,
  registerFixtureSeed,
  registerUnknownEntityResolutionSeed,
} from "../_fixtures/stateful-message-connector.ts";

const fixture = createStatefulMessageConnectorFixture({
  source: "discord-local",
  label: "Discord Local",
  conversations: [
    {
      channelId: "dm-bob-001",
      recipientId: "discord-user-bob-4488",
      label: "Bob",
      kind: "contact",
      messages: [
        {
          id: "discord-msg-bob-latest",
          sender: "Bob",
          text: "Are you close?",
          createdAt: Date.parse("2026-08-18T17:00:00.000Z"),
        },
      ],
    },
  ],
});

const sendParameters = {
  action: "send",
  source: "discord-local",
  accountId: "test-owner",
  target: "Bob",
  targetKind: "contact",
  message: "I'll be there soon.",
  persist: false,
};

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "discord.local.reply-to-dm",
  title: "Discord-local reply dispatches exact payload after confirmation",
  domain: "messaging.discord-local",
  tags: ["messaging", "discord", "confirmation", "dispatch-receipt"],
  description:
    "Exercises MESSAGE's real recipient-confirmation gate with a stateful Discord-local connector fixture, proving no preapproval dispatch and one exact postapproval provider receipt.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Discord Local Reply",
    },
  ],
  seed: [
    registerFixtureSeed(fixture),
    registerUnknownEntityResolutionSeed("I'll be there soon."),
  ],
  turns: [
    {
      kind: "action",
      name: "request-discord-send",
      room: "main",
      text: "Send Bob a Discord DM saying I'll be there soon.",
      content: {
        metadata: { __responseContext: { primaryContext: "messaging" } },
      },
      actionName: "MESSAGE",
      options: { parameters: sendParameters },
      assertTurn: () =>
        fixture.dispatches.length === 0
          ? undefined
          : "Discord dispatch occurred before owner confirmation",
    },
    {
      kind: "action",
      name: "confirm-discord-send",
      room: "main",
      text: "Yes, send that exact Discord DM now.",
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
      channel: "discord-local",
      turn: "request-discord-send",
      expected: false,
      maxCount: 0,
    },
    {
      type: "connectorDispatchOccurred",
      channel: "discord-local",
      turn: "confirm-discord-send",
      expected: true,
      minCount: 1,
      maxCount: 1,
    },
    {
      type: "custom",
      name: "discord-send-preserves-target-content-and-provider-receipt",
      predicate: (ctx) => {
        const dispatch = fixture.dispatches[0];
        const observed = ctx.connectorDispatches?.filter(
          (entry) => entry.channel === "discord-local",
        );
        return fixture.dispatches.length === 1 &&
          dispatch?.target.entityId === "discord-user-bob-4488" &&
          dispatch.content.text === "I'll be there soon." &&
          observed?.length === 1 &&
          observed[0]?.delivered === true &&
          observed[0]?.providerMessageIds?.[0] === dispatch.providerMessageId
          ? undefined
          : `expected one exact delivered Discord dispatch, saw ${JSON.stringify({ fixture: fixture.dispatches, observed })}`;
      },
    },
  ],
});
