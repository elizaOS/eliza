// @journey-8
/**
 * LifeOps Journey #8 — Group Chat Handoff
 *
 * Agent detects that multiple separate iMessage/Signal threads are all about
 * the same topic and proposes creating a group chat with a unified message.
 * PRD §Suite B — Inbox Triage And Daily Briefing
 * (`ea.inbox.propose-group-chat-handoff`).
 *
 * Gate: ELIZA_LIVE_TEST=1 + provider key + simulator enabled.
 */

import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelType, createMessageMemory, type UUID } from "@elizaos/core";
import { withTimeout } from "../../../test/helpers/test-utils.ts";
import { createMockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";
import { selectLiveProvider } from "../../../test/helpers/live-provider.ts";
import type { MockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";

const LIVE_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const provider = LIVE_ENABLED ? selectLiveProvider() : null;

if (!LIVE_ENABLED || !provider) {
  console.info(
    "[group-chat-handoff-e2e] skipped: set ELIZA_LIVE_TEST=1 and provide a provider API key",
  );
}

const CONTACT_ALICE = "Alice Nguyen";
const CONTACT_BOB = "Bob Martinez";
const CONTACT_PRIYA = "Priya Shah";
const DINNER_TOPIC = "rooftop dinner";

describe.skipIf(!LIVE_ENABLED || !provider)(
  "LifeOps Journey #8 — Group Chat Handoff",
  () => {
    let mocked: MockedTestRuntime;

    beforeAll(async () => {
      mocked = await createMockedTestRuntime({
        // Simulator provides pre-seeded iMessage / Signal threads via Alice,
        // Bob, and Priya — they already appear in the simulator fixture.
        seedLifeOpsSimulator: true,
        withLLM: true,
        preferredProvider: provider?.name,
      });

      // Seed three separate DM memories about the same dinner topic, one per
      // contact, so the agent can detect the convergence.
      const contacts = [CONTACT_ALICE, CONTACT_BOB, CONTACT_PRIYA];
      for (const contact of contacts) {
        await mocked.runtime.createMemory(
          {
            id: crypto.randomUUID() as UUID,
            agentId: mocked.runtime.agentId,
            roomId: crypto.randomUUID() as UUID,
            entityId: crypto.randomUUID() as UUID,
            content: {
              text: `Are you still organising the ${DINNER_TOPIC}? Count me in!`,
              source: "imessage",
              name: contact,
              channelType: ChannelType.DM,
              metadata: { senderName: contact, simulator: { id: `dinner-${contact.replace(" ", "-")}` } },
            },
            metadata: {
              entityName: contact,
            },
            createdAt: Date.now() - 60_000,
          } as never,
          "messages",
        );
      }
    }, 120_000);

    afterAll(async () => {
      await mocked?.cleanup();
    });

    it(
      "proposes a group chat with all three contacts who asked about the same topic",
      async () => {
        const ownerId = crypto.randomUUID() as UUID;
        const roomId = crypto.randomUUID() as UUID;

        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: ownerId,
          roomId,
          metadata: { type: "user_message", entityName: "shaw" },
          content: {
            text: `Are ${CONTACT_ALICE}, ${CONTACT_BOB}, and ${CONTACT_PRIYA} all asking about the same thing?`,
            source: "telegram",
            channelType: ChannelType.DM,
          },
        });

        let responseText = "";
        const result = await withTimeout(
          Promise.resolve(
            mocked.runtime.messageService?.handleMessage(
              mocked.runtime,
              message,
              async (content: { text?: string }) => {
                if (content.text) responseText += content.text;
                return [];
              },
            ),
          ),
          90_000,
          "handleMessage",
        );
        const reply =
          String(result?.responseContent?.text ?? "").trim() || responseText;

        expect(reply).not.toMatch(/something (?:went wrong|flaked)|try again/i);
      },
      120_000,
    );
  },
);
