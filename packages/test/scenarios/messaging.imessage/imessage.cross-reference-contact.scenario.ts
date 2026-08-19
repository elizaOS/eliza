/** Proves iMessage handle lookup returns the exact connector-backed contact identity. */

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
      channelId: "+14155551234",
      label: "Maya Chen",
      kind: "phone",
      messages: [],
    },
  ],
});

export default scenario({
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  id: "imessage.cross-reference-contact",
  title: "iMessage contact lookup resolves an exact phone handle",
  domain: "messaging.imessage",
  tags: ["messaging", "imessage", "contact-resolution", "typed-fixture"],
  description:
    "Calls MESSAGE.get_user through the connector contact-resolution hook and verifies the exact queried phone, resolved name, and normalized source metadata rather than inferring identity from prose.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "iMessage Contact Lookup",
    },
  ],
  seed: [registerFixtureSeed(fixture)],
  turns: [
    {
      kind: "action",
      name: "lookup-imessage-handle",
      room: "main",
      text: "Look up +14155551234 in iMessage contacts.",
      content: {
        metadata: { __responseContext: { primaryContext: "messaging" } },
      },
      actionName: "MESSAGE",
      options: {
        parameters: {
          action: "get_user",
          source: "imessage",
          accountId: "default",
          handle: "+14155551234",
        },
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "imessage-handle-resolves-exact-contact",
      predicate: (ctx) => {
        const blob = JSON.stringify(ctx.actionsCalled);
        return fixture.userLookups.length === 1 &&
          fixture.userLookups[0]?.handle === "+14155551234" &&
          blob.includes("Maya Chen") &&
          blob.includes("+14155551234") &&
          blob.includes("imessage")
          ? undefined
          : `expected exact iMessage contact resolution, saw ${JSON.stringify({ lookups: fixture.userLookups, actions: ctx.actionsCalled })}`;
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
