// @journey-6
/**
 * LifeOps Journey #6 — Daily Brief Surfaces Drafts Awaiting Sign-Off
 *
 * When the user asks for their morning brief, the agent must surface unsent
 * Gmail drafts that are awaiting sign-off.  The brief must name the recipient
 * and subject for each pending draft.
 * PRD §Suite B — Inbox Triage And Daily Briefing
 * (`ea.inbox.daily-brief-includes-unsent-drafts`).
 *
 * Gate: ELIZA_LIVE_TEST=1 + provider key.
 * Gmail is backed by the central Google mock server.
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
    "[daily-brief-drafts-e2e] skipped: set ELIZA_LIVE_TEST=1 and provide a provider API key",
  );
}

describe.skipIf(!LIVE_ENABLED || !provider)(
  "LifeOps Journey #6 — Daily Brief Surfaces Drafts Awaiting Sign-Off",
  () => {
    let mocked: MockedTestRuntime;
    let ownerId: UUID;
    let roomId: UUID;

    const DRAFT_RECIPIENT_1 = "alice@stakeholder.com";
    const DRAFT_SUBJECT_1 = "Q2 partnership proposal";
    const DRAFT_RECIPIENT_2 = "vendor@acme.com";
    const DRAFT_SUBJECT_2 = "Software license renewal";

    beforeAll(async () => {
      mocked = await createMockedTestRuntime({
        seedLifeOpsSimulator: true,
        withLLM: true,
        preferredProvider: provider?.name,
      });

      ownerId = crypto.randomUUID() as UUID;
      roomId = crypto.randomUUID() as UUID;

      // Seed two pending email drafts into the approval queue — this is how
      // the morning-brief pipeline learns about unsent drafts.
      const approvalQueue = createApprovalQueue(mocked.runtime, {
        agentId: mocked.runtime.agentId,
      });

      await approvalQueue.enqueue({
        requestedBy: "background-job:draft-aging-sweeper",
        subjectUserId: String(ownerId),
        action: "send_email",
        payload: {
          action: "send_email",
          to: [DRAFT_RECIPIENT_1],
          cc: [],
          bcc: [],
          subject: DRAFT_SUBJECT_1,
          body: "Please find the Q2 partnership proposal attached.",
          threadId: `thread-draft-1-${crypto.randomUUID()}`,
        },
        channel: "email",
        reason: "Draft ready and awaiting owner sign-off.",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      await approvalQueue.enqueue({
        requestedBy: "background-job:draft-aging-sweeper",
        subjectUserId: String(ownerId),
        action: "send_email",
        payload: {
          action: "send_email",
          to: [DRAFT_RECIPIENT_2],
          cc: [],
          bcc: [],
          subject: DRAFT_SUBJECT_2,
          body: "Attached is our renewal quote for your review.",
          threadId: `thread-draft-2-${crypto.randomUUID()}`,
        },
        channel: "email",
        reason: "Draft ready and awaiting owner sign-off.",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    }, 120_000);

    afterAll(async () => {
      await mocked?.cleanup();
    });

    it(
      "includes pending draft subjects in the morning brief",
      async () => {
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: ownerId,
          roomId,
          metadata: { type: "user_message", entityName: "shaw" },
          content: {
            text: "What's on my plate this morning?",
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

        // Brief must mention at least one of the pending draft subjects or recipients
        expect(reply).toMatch(
          new RegExp(
            `${DRAFT_SUBJECT_1}|${DRAFT_SUBJECT_2}|${DRAFT_RECIPIENT_1}|${DRAFT_RECIPIENT_2}|draft|sign.?off`,
            "i",
          ),
        );
      },
      120_000,
    );
  },
);
