// @journey-14
/**
 * LifeOps Journey #14 — Flight Conflict Detection And Rebooking
 *
 * Calendar conflict detected → agent proposes alternative flights → rebook
 * executed after approval → calendar updated.
 *
 * PRD §Suite D — Travel And Event Operations
 * (`ea.travel.flight-conflict-rebooking`).
 *
 * Setup: a flight arrival and a calendar event one hour later that the agent
 * detects as an unsafe connection after baggage and local travel.
 *
 * Gate: ELIZA_LIVE_TEST=1 + provider key.
 */

import crypto from "node:crypto";
import { ChannelType, createMessageMemory, type UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectLiveProvider } from "../../../packages/app-core/test/helpers/live-provider.ts";
import { withTimeout } from "../../../packages/app-core/test/helpers/test-utils.ts";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import { judgeTextWithLlm } from "./helpers/lifeops-live-judge.ts";
import { seedDurableGoogleCalendar } from "./support/helpers/durable-google-calendar.ts";
import type { MockedTestRuntime } from "./support/helpers/mock-runtime.ts";
import { createMockedTestRuntime } from "./support/helpers/mock-runtime.ts";

const LIVE_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const provider = LIVE_ENABLED ? selectLiveProvider() : null;

if (!LIVE_ENABLED || !provider) {
  console.info(
    "[flight-rebook-e2e] skipped: set ELIZA_LIVE_TEST=1 and provide a provider API key",
  );
}

describe.skipIf(!LIVE_ENABLED || !provider)(
  "LifeOps Journey #14 — Flight Conflict Detection And Rebooking",
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

      const flightStart = Date.now() + 72 * 60 * 60_000;
      await seedDurableGoogleCalendar({
        runtime: mocked.runtime,
        grantId: "journey-14-google-calendar",
        events: [
          {
            id: "journey-14-flight",
            title: "Flight SFO → JFK — morning arrival",
            startAt: new Date(flightStart).toISOString(),
            endAt: new Date(flightStart + 30 * 60_000).toISOString(),
            timezone: "America/New_York",
            description:
              "Flight arrives one hour before a board meeting; baggage claim and local travel make the connection unsafe",
          },
          {
            id: "journey-14-board-meeting",
            title: "Board Meeting — NYC office",
            startAt: new Date(flightStart + 60 * 60_000).toISOString(),
            endAt: new Date(flightStart + 3 * 60 * 60_000).toISOString(),
            timezone: "America/New_York",
          },
        ],
      });

      mocked.mocks.clearRequestLedger();
    }, 120_000);

    afterAll(async () => {
      await mocked?.cleanup();
    });

    it("detects the flight/meeting conflict and proposes alternative earlier flights", async () => {
      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: ownerId,
        roomId,
        metadata: { type: "user_message", entityName: "shaw" },
        content: {
          text: "Can I make my upcoming board meeting given my morning flight to JFK that lands only one hour before it?",
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

      // The agent must do real work: either (a) enqueue a `book_travel`
      // approval for an earlier flight, or (b) actually surface alternative
      // flights / a rebooking plan in the reply. We do NOT pre-populate the
      // approval queue ourselves — if the agent does nothing, this test
      // fails (which is the correct outcome).
      const approvalQueue = createApprovalQueue(mocked.runtime, {
        agentId: mocked.runtime.agentId,
      });
      const pending = await approvalQueue.list({
        subjectUserId: String(ownerId),
        state: "pending",
        action: null,
        limit: 10,
      });
      const enqueuedRebook = pending.some((request) => {
        const payload = JSON.stringify(request.payload).toLowerCase();
        return (
          request.action === "book_travel" &&
          (payload.includes("flight") ||
            payload.includes("sfo") ||
            payload.includes("jfk"))
        );
      });

      const judgement = await judgeTextWithLlm({
        label: "flight-rebook.detected-conflict-and-proposed",
        rubric:
          "The reply must (1) acknowledge the unsafe one-hour connection between the JFK arrival and the board meeting AND (2) either propose at least one specific alternative (e.g. an earlier flight, a calendar move, a remote-attend option) or describe a concrete rebooking plan. A reply that only restates the question, only says 'I'll check', or asks unrelated questions fails. The reply does NOT need to actually book anything — just propose.",
        text: reply,
        minimumScore: 0.7,
      });

      expect(
        enqueuedRebook || judgement.passed,
        `Agent must either enqueue a book_travel approval or surface a rebooking proposal in the reply. Approvals=${pending.length}, judge=${JSON.stringify(judgement)}`,
      ).toBe(true);
    }, 120_000);
  },
);
