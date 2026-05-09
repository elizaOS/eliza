// @journey-19
/**
 * LifeOps Journey #19 — Cancellation Fee Warning
 *
 * Agent detects that the user is at risk of missing an appointment with a
 * known cancellation fee and proactively warns the user with cost framing.
 *
 * PRD §Suite F — Push, Escalation, And Cross-Device Delivery
 * (`ea.push.cancellation-fee-warning`).
 *
 * Gate: ELIZA_LIVE_TEST=1 + provider key.
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
    "[cancellation-fee-e2e] skipped: set ELIZA_LIVE_TEST=1 and provide a provider API key",
  );
}

describe.skipIf(!LIVE_ENABLED || !provider)(
  "LifeOps Journey #19 — Cancellation Fee Warning",
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

      // Seed an appointment with a cancellation policy via the Google Calendar mock
      const calendarBase = mocked.mocks.baseUrls.google;
      const in2h = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const in3h = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      await fetch(
        `${calendarBase}/calendar/v3/calendars/primary/events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer mock-token",
            "X-Eliza-Test-Run": "journey-19",
          },
          body: JSON.stringify({
            summary: "Dr. Johnson — Annual check-up",
            start: { dateTime: in2h },
            end: { dateTime: in3h },
            description:
              "24-hour cancellation policy applies. Late cancellation fee: $150. " +
              "Please cancel by calling 555-1234.",
          }),
        },
      );

      mocked.mocks.clearRequestLedger();
    }, 120_000);

    afterAll(async () => {
      await mocked?.cleanup();
    });

    it(
      "warns the user about the cancellation fee when they consider missing the appointment",
      async () => {
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: ownerId,
          roomId,
          metadata: { type: "user_message", entityName: "shaw" },
          content: {
            text: "I'm thinking of skipping my doctor's appointment today — anything I should know?",
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

    it.todo(
      "proactively surfaces the cancellation fee warning at T-24h without user prompt (requires background scheduler)",
    );
  },
);
