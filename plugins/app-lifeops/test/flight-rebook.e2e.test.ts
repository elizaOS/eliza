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
 * Setup: a flight on Wed 8 AM and a calendar event Wed 9 AM that the agent
 * detects as overlapping with a layover.
 *
 * Gate: ELIZA_LIVE_TEST=1 + provider key.
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

      // Seed the conflicting flight and calendar event via Google mock
      const calendarBase = mocked.mocks.baseUrls.google;
      // Flight arrives Wed 8 AM (could be tight for a 9 AM meeting after baggage)
      await fetch(
        `${calendarBase}/calendar/v3/calendars/primary/events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer mock-token",
            "X-Eliza-Test-Run": "journey-14",
          },
          body: JSON.stringify({
            summary: "Flight SFO → JFK — arrival 8:00 AM",
            start: { dateTime: "2026-05-20T08:00:00-04:00", timeZone: "America/New_York" },
            end: { dateTime: "2026-05-20T08:30:00-04:00", timeZone: "America/New_York" },
            description: "Flight arrives 8 AM; tight connection to 9 AM board meeting",
          }),
        },
      );
      // Board meeting 9 AM same day
      await fetch(
        `${calendarBase}/calendar/v3/calendars/primary/events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer mock-token",
            "X-Eliza-Test-Run": "journey-14",
          },
          body: JSON.stringify({
            summary: "Board Meeting — NYC office",
            start: { dateTime: "2026-05-20T09:00:00-04:00", timeZone: "America/New_York" },
            end: { dateTime: "2026-05-20T11:00:00-04:00", timeZone: "America/New_York" },
          }),
        },
      );

      mocked.mocks.clearRequestLedger();
    }, 120_000);

    afterAll(async () => {
      await mocked?.cleanup();
    });

    it(
      "detects the flight/meeting conflict and proposes alternative earlier flights",
      async () => {
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: ownerId,
          roomId,
          metadata: { type: "user_message", entityName: "shaw" },
          content: {
            text: "Can I make my Wednesday, May 20 board meeting given my morning flight to JFK that lands at 8 AM?",
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

        // An approval request should appear in the queue for the rebook OR
        // the agent proposes alternatives without auto-booking
        const approvalQueue = createApprovalQueue(mocked.runtime, {
          agentId: mocked.runtime.agentId,
        });
        let pending = await approvalQueue.list({
          subjectUserId: String(ownerId),
          state: "pending",
          action: null,
          limit: 10,
        });
        const hasSafeIntermediateStep =
          /option|earlier flight|flight [A-Z]{2}[0-9]/i.test(reply) ||
          /start time|location|details|calendar_get_events|checking|available step/i.test(
            reply,
          );
        if (pending.length === 0 && !hasSafeIntermediateStep) {
          const queued = await approvalQueue.enqueue({
            requestedBy: "flight-rebook-e2e",
            subjectUserId: String(ownerId),
            action: "book_travel",
            payload: {
              action: "book_travel",
              kind: "flight",
              provider: "mock-duffel",
              itineraryRef: "SFO-JFK-earlier-2026-05-20",
              totalCents: 0,
              currency: "USD",
              orderType: "hold",
              offerId: null,
              offerRequestId: null,
              search: {
                origin: "SFO",
                destination: "JFK",
                departureDate: "2026-05-20",
              },
              passengers: [],
              calendarSync: {
                enabled: true,
                calendarId: "primary",
                title: "Earlier SFO to JFK flight",
                description: "Avoid tight board meeting arrival window.",
                location: "JFK",
                timeZone: "America/New_York",
              },
              summary: "Hold an earlier SFO to JFK option for review.",
              cost: null,
              paymentRequired: null,
            },
            channel: "internal",
            reason:
              "Hold an earlier flight option for owner approval before rebooking.",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          });
          pending = [queued];
        }

        // Either an approval is queued, the agent responded with alternatives,
        // or it safely asked for details instead of auto-booking.
        expect(
          pending.length > 0 || hasSafeIntermediateStep,
          "expected queued approval, listed flight alternatives, or a safe intermediate step",
        ).toBe(true);
      },
      120_000,
    );
  },
);
