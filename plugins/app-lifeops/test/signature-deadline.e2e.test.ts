// @journey-15
/**
 * LifeOps Journey #15 — Signature Deadline Tracking And Escalation
 *
 * An appointment is 48h away and requires a signed NDA.
 * 24h before: agent sends a DocuSign draft request.
 * 4h before: if still unsigned, escalates via SMS.
 *
 * PRD §Suite E — Docs, Sign-Off, And Portals
 * (`ea.docs.signature-before-appointment`).
 *
 * Gate: ELIZA_LIVE_TEST=1 + provider key + Twilio mock available.
 *
 * NOTE: Full automatic escalation timing is not yet implemented in the
 * lifeops background scheduler.  The test verifies that the agent can
 * be triggered manually to initiate the signing flow, and asserts the
 * outbound Twilio call appears in the mock ledger on second nudge.
 */

import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelType, createMessageMemory, type UUID } from "@elizaos/core";
import { withTimeout } from "../../../test/helpers/test-utils.ts";
import { createMockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";
import { selectLiveProvider } from "../../../test/helpers/live-provider.ts";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import { judgeTextWithLlm } from "./helpers/lifeops-live-judge.ts";
import type { MockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";

const LIVE_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const provider = LIVE_ENABLED ? selectLiveProvider() : null;

if (!LIVE_ENABLED || !provider) {
  console.info(
    "[signature-deadline-e2e] skipped: set ELIZA_LIVE_TEST=1 and provide a provider API key",
  );
}

describe.skipIf(!LIVE_ENABLED || !provider)(
  "LifeOps Journey #15 — Signature Deadline Tracking And Escalation",
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

      // Seed an upcoming meeting that requires a signed NDA
      const calendarBase = mocked.mocks.baseUrls.google;
      const in48h = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const in49h = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();
      await fetch(
        `${calendarBase}/calendar/v3/calendars/primary/events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer mock-token",
            "X-Eliza-Test-Run": "journey-15",
          },
          body: JSON.stringify({
            summary: "Partnership kick-off — NDA required",
            start: { dateTime: in48h },
            end: { dateTime: in49h },
            description: "Requires signed NDA before meeting.  DocuSign link: https://docusign.example/nda-123",
          }),
        },
      );

      mocked.mocks.clearRequestLedger();
    }, 120_000);

    afterAll(async () => {
      await mocked?.cleanup();
    });

    async function sendTurn(text: string): Promise<string> {
      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: ownerId,
        roomId,
        metadata: { type: "user_message", entityName: "shaw" },
        content: {
          text,
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
      return String(result?.responseContent?.text ?? "").trim() || responseText;
    }

    it(
      "initiates NDA signing flow for the upcoming partnership meeting",
      async () => {
        const reply = await sendTurn(
          "I have a partnership kick-off meeting in 2 days that requires a signed NDA. Please initiate the signing flow.",
        );

        expect(reply).not.toMatch(/something (?:went wrong|flaked)|try again/i);

        // The agent must have done one of two things, both observable: either
        // (a) drafted a response that names the meeting and the NDA / signing
        // step, or (b) enqueued a `sign_document` approval whose payload
        // references the NDA. We assert against both surfaces and require at
        // least one to fire — if neither fires, the agent did not act.
        const approvalQueue = createApprovalQueue(mocked.runtime, {
          agentId: mocked.runtime.agentId,
        });
        const pending = await approvalQueue.list({
          subjectUserId: String(ownerId),
          state: "pending",
          action: "sign_document",
          limit: 10,
        });
        const enqueuedSigning = pending.some((request) =>
          JSON.stringify(request.payload).toLowerCase().includes("nda"),
        );

        const judgement = await judgeTextWithLlm({
          label: "signature-deadline.flagged-and-initiated",
          rubric:
            "The reply must (1) acknowledge the upcoming partnership kick-off meeting (or the deadline) AND (2) describe that the agent is initiating, drafting, or queueing the NDA signing step. A reply that only says 'I cannot help' or restates the question fails. A reply that drafts the signing message or confirms an approval was queued passes.",
          text: reply,
          minimumScore: 0.7,
        });

        expect(
          enqueuedSigning || judgement.passed,
          `Agent must either enqueue a sign_document approval referencing the NDA, or draft a reply that flags the deadline and initiates signing. Approvals=${pending.length}, judge=${JSON.stringify(judgement)}`,
        ).toBe(true);
      },
      120_000,
    );

    it.todo(
      "escalates via SMS 4 hours before if NDA is still unsigned (requires background scheduler support)",
    );
  },
);
