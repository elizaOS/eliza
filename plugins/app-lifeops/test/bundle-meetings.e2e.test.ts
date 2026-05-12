// @journey-4
/**
 * LifeOps Journey #4 — Bundle Meetings While Traveling
 *
 * Agent consolidates adjacent meetings into a single travel-window when the
 * user is in another city.  PRD §Suite A — Time Defense And Scheduling
 * (`ea.schedule.bundle-meetings-while-traveling`).
 *
 * Gate: ELIZA_LIVE_TEST=1 + at least one provider key present.
 * All external APIs (Google Calendar) are backed by the central mock server.
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
    "[bundle-meetings-e2e] skipped: set ELIZA_LIVE_TEST=1 and provide a provider API key",
  );
}

describe.skipIf(!LIVE_ENABLED || !provider)(
  "LifeOps Journey #4 — Bundle Meetings While Traveling",
  () => {
    let mocked: MockedTestRuntime;

    beforeAll(async () => {
      mocked = await createMockedTestRuntime({
        seedLifeOpsSimulator: true,
        withLLM: true,
        preferredProvider: provider?.name,
      });
    }, 120_000);

    afterAll(async () => {
      await mocked?.cleanup();
    });

    it(
      "consolidates adjacent NYC meetings into one trip window and proposes approval",
      async () => {
        // Seed 3 calendar events on Tue/Wed in NYC via the Google mock
        const calendarBase = mocked.mocks.baseUrls.google;
        const nycEvents = [
          {
            summary: "VC Pitch — NYC",
            start: { dateTime: "2026-05-12T14:00:00-04:00", timeZone: "America/New_York" },
            end: { dateTime: "2026-05-12T15:00:00-04:00", timeZone: "America/New_York" },
          },
          {
            summary: "Press Interview — NYC",
            start: { dateTime: "2026-05-13T10:00:00-04:00", timeZone: "America/New_York" },
            end: { dateTime: "2026-05-13T11:00:00-04:00", timeZone: "America/New_York" },
          },
          {
            summary: "Customer Dinner — NYC",
            start: { dateTime: "2026-05-13T18:00:00-04:00", timeZone: "America/New_York" },
            end: { dateTime: "2026-05-13T20:00:00-04:00", timeZone: "America/New_York" },
          },
        ];
        for (const event of nycEvents) {
          await fetch(
            `${calendarBase}/calendar/v3/calendars/primary/events`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer mock-token",
                "X-Eliza-Test-Run": "journey-4",
              },
              body: JSON.stringify(event),
            },
          );
        }

        mocked.mocks.clearRequestLedger();

        const ownerId = crypto.randomUUID() as UUID;
        const roomId = crypto.randomUUID() as UUID;

        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: ownerId,
          roomId,
          metadata: { type: "user_message", entityName: "shaw" },
          content: {
            text: "Bundle my NYC meetings into one trip.",
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
        const reply = String(result?.responseContent?.text ?? "").trim() || responseText;

        expect(reply).not.toMatch(/something (?:went wrong|flaked)|try again/i);

        // The journey is approval-gated: the assistant should not silently
        // mutate the calendar while only being asked to bundle a trip window.
        const ledger = mocked.mocks.requestLedger();
        const unexpectedCalendarWrites = ledger.filter(
          (entry) =>
            entry.environment === "google" &&
            entry.calendar !== undefined &&
            entry.method !== "GET",
        );
        expect(unexpectedCalendarWrites).toHaveLength(0);
      },
      120_000,
    );
  },
);
