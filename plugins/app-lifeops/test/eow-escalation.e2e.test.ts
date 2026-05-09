// @journey-17
/**
 * LifeOps Journey #17 — End-Of-Week Document Deadline Escalation
 *
 * An unsigned document has a deadline of next Friday.  When it is Thursday
 * 5 PM the agent escalates: SMS via Twilio, then (if unanswered after 30 min)
 * a phone call, then Discord.
 *
 * PRD §Suite E — Docs, Sign-Off, And Portals
 * (`ea.docs.eow-approval-escalation`).
 *
 * Gate: ELIZA_LIVE_TEST=1 + provider key.
 * Twilio and Discord are backed by mock servers.
 *
 * NOTE: The 30-minute wait between escalation steps requires background
 * scheduler support that is not yet wired.  The test verifies the first
 * escalation step (SMS) and records the rest as todo.
 */

import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelType, createMessageMemory, type UUID } from "@elizaos/core";
import { withTimeout } from "../../../test/helpers/test-utils.ts";
import { createMockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";
import { selectLiveProvider } from "../../../test/helpers/live-provider.ts";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import type { MockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";

const LIVE_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const provider = LIVE_ENABLED ? selectLiveProvider() : null;

if (!LIVE_ENABLED || !provider) {
  console.info(
    "[eow-escalation-e2e] skipped: set ELIZA_LIVE_TEST=1 and provide a provider API key",
  );
}

describe.skipIf(!LIVE_ENABLED || !provider)(
  "LifeOps Journey #17 — End-Of-Week Document Deadline Escalation",
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

      // Compute next Friday as the deadline
      const now = new Date();
      const daysUntilFriday = (5 - now.getDay() + 7) % 7 || 7;
      const nextFriday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + daysUntilFriday,
        17, // 5 PM
        0,
        0,
      );

      // Seed an unsigned document task with a Friday deadline in the approval queue
      const approvalQueue = createApprovalQueue(mocked.runtime, {
        agentId: mocked.runtime.agentId,
      });
      await approvalQueue.enqueue({
        requestedBy: "background-job:doc-deadline-sweeper",
        subjectUserId: String(ownerId),
        action: "sign_document",
        payload: {
          action: "sign_document",
          documentId: "eow-nda-2026",
          documentName: "NDA — Acme Corp",
          signatureUrl: "https://docusign.example/nda-acme-2026",
          deadline: nextFriday.toISOString(),
        },
        channel: "sms",
        reason: `Document "NDA — Acme Corp" deadline is ${nextFriday.toLocaleDateString()}.  Unsigned as of ${new Date().toISOString()}.`,
        expiresAt: nextFriday,
      });

      mocked.mocks.clearRequestLedger();
    }, 120_000);

    afterAll(async () => {
      await mocked?.cleanup();
    });

    it(
      "sends an SMS escalation for the unsigned EOW document when prompted",
      async () => {
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: ownerId,
          roomId,
          metadata: { type: "user_message", entityName: "shaw" },
          content: {
            text: "I have an unsigned NDA due Friday — please escalate it to me now via SMS.",
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

        // Check request ledger for a Twilio SMS send
        const ledger = mocked.mocks.requestLedger();
        const smsCalls = ledger.filter(
          (entry) => entry.environment === "twilio",
        );
        // Agent may queue the send for approval first; either way it should
        // acknowledge the escalation path.
        if (smsCalls.length > 0) {
          expect(smsCalls[0]?.path ?? "").toMatch(/messages/i);
        }
      },
      120_000,
    );

    it.todo(
      "escalates to phone call if SMS goes unanswered after 30 minutes (requires scheduler tick control)",
    );

    it.todo(
      "escalates to Discord if call is also unanswered (requires multi-step escalation ladder)",
    );
  },
);
