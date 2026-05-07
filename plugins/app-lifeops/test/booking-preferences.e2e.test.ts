// @journey-12
/**
 * LifeOps Journey #12 — Travel Booking Preference Capture And Reuse
 *
 * Step 1: User states seat, bag, hotel budget, and proximity preferences.
 * Step 2 (separate turn): User asks to book a trip — agent uses captured
 * preferences without re-asking.
 * PRD §Suite D — Travel And Event Operations
 * (`ea.travel.capture-booking-preferences`).
 *
 * Gate: ELIZA_LIVE_TEST=1 + provider key.
 * Travel APIs are backed by the Duffel section of the central mock.
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
    "[booking-preferences-e2e] skipped: set ELIZA_LIVE_TEST=1 and provide a provider API key",
  );
}

describe.skipIf(!LIVE_ENABLED || !provider)(
  "LifeOps Journey #12 — Travel Booking Preference Capture And Reuse",
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
      "captures travel preferences in turn 1 and reuses them without re-asking in turn 2",
      async () => {
        // Turn 1: capture preferences
        const prefReply = await sendTurn(
          "For all future travel bookings: I prefer aisle seat, no checked bag, " +
            "hotels under $300/night within 1 mile of the venue.",
        );
        // Agent should confirm the preferences were saved
        expect(prefReply).toMatch(/aisle|prefer|saved|noted|got it/i);

        // Turn 2: request a booking — agent should not re-ask for preferences
        const bookReply = await sendTurn("Book my LA trip next month.");

        // Agent must NOT ask for seat preference or hotel budget again
        expect(bookReply).not.toMatch(/what seat|what hotel budget|hotel budget\?|seat preference\?/i);

        // Agent should proceed toward searching / proposing options
        expect(bookReply).toMatch(/LA|Los Angeles|flight|hotel|trip|search|option/i);
      },
      180_000,
    );
  },
);
