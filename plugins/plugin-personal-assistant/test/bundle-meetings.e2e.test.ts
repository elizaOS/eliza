// @journey-4
/**
 * LifeOps Journey #4 — Bundle Meetings While Traveling
 *
 * Agent consolidates adjacent meetings into a single travel-window when the
 * user is in another city.  PRD §Suite A — Time Defense And Scheduling
 * (`ea.schedule.bundle-meetings-while-traveling`).
 *
 * Gate: ELIZA_LIVE_TEST=1 + at least one provider key present. Calendar context
 * is seeded in the durable read-only cache used by the Google MCP adapter.
 */

import crypto from "node:crypto";
import { ChannelType, createMessageMemory, type UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectLiveProvider } from "../../../packages/app-core/test/helpers/live-provider.ts";
import { withTimeout } from "../../../packages/app-core/test/helpers/test-utils.ts";
import { seedDurableGoogleCalendar } from "./support/helpers/durable-google-calendar.ts";
import type { MockedTestRuntime } from "./support/helpers/mock-runtime.ts";
import { createMockedTestRuntime } from "./support/helpers/mock-runtime.ts";

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

    it("consolidates adjacent NYC meetings into one trip window and proposes approval", async () => {
      const tripStart = Date.now() + 48 * 60 * 60_000;
      const nycEvents = [
        {
          id: "journey-4-vc-pitch",
          title: "VC Pitch — NYC",
          startAt: new Date(tripStart).toISOString(),
          endAt: new Date(tripStart + 60 * 60_000).toISOString(),
          location: "New York, NY",
        },
        {
          id: "journey-4-press-interview",
          title: "Press Interview — NYC",
          startAt: new Date(tripStart + 20 * 60 * 60_000).toISOString(),
          endAt: new Date(tripStart + 21 * 60 * 60_000).toISOString(),
          location: "New York, NY",
        },
        {
          id: "journey-4-customer-dinner",
          title: "Customer Dinner — NYC",
          startAt: new Date(tripStart + 28 * 60 * 60_000).toISOString(),
          endAt: new Date(tripStart + 30 * 60 * 60_000).toISOString(),
          location: "New York, NY",
        },
      ];
      const repository = await seedDurableGoogleCalendar({
        runtime: mocked.runtime,
        grantId: "journey-4-google-calendar",
        events: nycEvents,
      });
      const before = await repository.listCalendarEvents(
        String(mocked.runtime.agentId),
        "google",
        undefined,
        undefined,
        "owner",
      );

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
      const reply =
        String(result?.responseContent?.text ?? "").trim() || responseText;

      expect(reply).not.toMatch(/something (?:went wrong|flaked)|try again/i);

      // Google Calendar is read-only: a planning request must leave its
      // durable provider snapshot unchanged.
      const after = await repository.listCalendarEvents(
        String(mocked.runtime.agentId),
        "google",
        undefined,
        undefined,
        "owner",
      );
      expect(after).toEqual(before);
    }, 120_000);
  },
);
