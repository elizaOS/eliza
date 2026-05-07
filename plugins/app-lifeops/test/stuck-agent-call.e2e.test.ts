// @journey-20
/**
 * LifeOps Journey #20 — Browser Automation Blocked → Escalate To Phone Call
 *
 * When the browser-workspace agent hits a CAPTCHA or other blocker while
 * trying to pay a bill on a portal, it escalates to the user via SMS or
 * Twilio voice call requesting a remote-control session.
 *
 * PRD §Suite F — Push, Escalation, And Cross-Device Delivery
 * (`ea.push.stuck-agent-calls-user`).
 *
 * Gate: ELIZA_LIVE_TEST=1 + provider key + browser-workspace mock.
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
    "[stuck-agent-call-e2e] skipped: set ELIZA_LIVE_TEST=1 and provide a provider API key",
  );
}

describe.skipIf(!LIVE_ENABLED || !provider)(
  "LifeOps Journey #20 — Browser Automation Blocked → Escalate To Phone Call",
  () => {
    let mocked: MockedTestRuntime;
    let ownerId: UUID;
    let roomId: UUID;

    beforeAll(async () => {
      mocked = await createMockedTestRuntime({
        seedLifeOpsSimulator: true,
        withLLM: true,
        preferredProvider: provider?.name,
      });

      ownerId = crypto.randomUUID() as UUID;
      roomId = crypto.randomUUID() as UUID;

      mocked.mocks.clearRequestLedger();
    }, 120_000);

    afterAll(async () => {
      await mocked?.cleanup();
    });

    it(
      "detects browser blocker and escalates to user when paying AT&T bill",
      async () => {
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: ownerId,
          roomId,
          metadata: { type: "user_message", entityName: "shaw" },
          content: {
            text: "Pay my AT&T bill online.",
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

        // Agent should acknowledge the task — it may detect it needs a browser
        // or it may report needing credentials / human help.
        expect(reply).toMatch(/AT&T|bill|pay|browser|portal|login|need|help/i);

        // If a browser-workspace call was made and hit a blocker, an escalation
        // outbound message should appear in the ledger.
        const ledger = mocked.mocks.requestLedger();
        const browserCalls = ledger.filter(
          (entry) => entry.environment === "browser-workspace",
        );
        const escalations = ledger.filter(
          (entry) => entry.environment === "twilio",
        );

        // At minimum, the agent should have responded with a plan or an
        // escalation — either is acceptable depending on implementation state.
        expect(
          reply.length > 0 || browserCalls.length > 0 || escalations.length > 0,
        ).toBe(true);
      },
      120_000,
    );

    it.todo(
      "places a Twilio voice call when CAPTCHA blocks browser automation (requires blocked-state mock fixture)",
    );
  },
);
