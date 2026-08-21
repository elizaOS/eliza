/** Proves an exact Signal payload reaches the connector only after owner confirmation. */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
  createStatefulMessageConnectorFixture,
  registerFixtureSeed,
  registerUnknownEntityResolutionSeed,
} from "../_fixtures/stateful-message-connector.ts";

const fixture = createStatefulMessageConnectorFixture({
  source: "signal",
  label: "Signal",
  conversations: [
    {
      channelId: "+14155550888",
      recipientId: "+14155550888",
      label: "Dana",
      kind: "contact",
      messages: [
        {
          id: "signal-dana-latest",
          sender: "Dana",
          text: "Did the booking go through?",
          createdAt: Date.parse("2026-08-18T18:55:00.000Z"),
        },
      ],
    },
  ],
});

const sendParameters = {
  action: "send",
  source: "signal",
  accountId: "test-owner",
  target: "Dana",
  targetKind: "contact",
  message: "I confirmed the booking.",
  persist: false,
};

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "signal.reply",
  title: "Signal reply dispatches exact payload after confirmation",
  domain: "messaging.signal",
  tags: ["messaging", "signal", "confirmation", "dispatch-receipt"],
  description:
    "Runs the real MESSAGE recipient-confirmation gate against a stateful Signal connector fixture and verifies one exact E.164 target, payload, and provider-style receipt after approval.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Signal Reply",
    },
  ],
  seed: [
    registerFixtureSeed(fixture),
    registerUnknownEntityResolutionSeed("I confirmed the booking."),
  ],
  turns: [
    {
      kind: "action",
      name: "request-signal-send",
      room: "main",
      text: "Send Dana a Signal message saying I confirmed the booking.",
      content: {
        metadata: { __responseContext: { primaryContext: "messaging" } },
      },
      actionName: "MESSAGE",
      options: { parameters: sendParameters },
      assertTurn: () =>
        fixture.dispatches.length === 0
          ? undefined
          : "Signal dispatched before explicit approval",
    },
    {
      kind: "action",
      name: "confirm-signal-send",
      room: "main",
      text: "Yes, send that exact Signal message now.",
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
      channel: "signal",
      turn: "request-signal-send",
      expected: false,
      maxCount: 0,
    },
    {
      type: "connectorDispatchOccurred",
      channel: "signal",
      turn: "confirm-signal-send",
      minCount: 1,
      maxCount: 1,
    },
    {
      type: "custom",
      name: "signal-send-is-exact-and-receipted",
      predicate: (ctx) => {
        const dispatch = fixture.dispatches[0];
        const observed = ctx.connectorDispatches?.filter(
          (entry) => entry.channel === "signal",
        );
        return fixture.dispatches.length === 1 &&
          dispatch?.target.entityId === "+14155550888" &&
          dispatch.content.text === "I confirmed the booking." &&
          observed?.length === 1 &&
          observed[0]?.delivered === true &&
          observed[0]?.providerMessageIds?.[0] === dispatch.providerMessageId
          ? undefined
          : `expected one exact delivered Signal dispatch, saw ${JSON.stringify({ fixture: fixture.dispatches, observed })}`;
      },
    },
  ],
});
