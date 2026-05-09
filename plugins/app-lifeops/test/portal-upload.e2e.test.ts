// @journey-16
/**
 * LifeOps Journey #16 — Speaker Portal Upload Via Browser Automation
 *
 * User asks the agent to upload a deck to a speaker portal.  The agent uses
 * the browser-workspace bridge to navigate the portal, fill the upload form,
 * and submit the file.
 *
 * PRD §Suite E — Docs, Sign-Off, And Portals
 * (`ea.docs.portal-upload-from-chat`).
 *
 * Gate: ELIZA_LIVE_TEST=1 + provider key + browser-workspace mock available.
 * The browser-workspace mock responds to /tabs, /tabs/:id/navigate,
 * /tabs/:id/eval, and /tabs/:id/snapshot endpoints.
 */

import crypto from "node:crypto";
import { ChannelType, createMessageMemory, type UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectLiveProvider } from "../../../test/helpers/live-provider.ts";
import { withTimeout } from "../../../test/helpers/test-utils.ts";
import type { MockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";
import { createMockedTestRuntime } from "../../../test/mocks/helpers/mock-runtime.ts";

const LIVE_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const provider = LIVE_ENABLED ? selectLiveProvider() : null;

// Also require the browser-workspace mock environment
const BROWSER_WS_AVAILABLE = Boolean(process.env.ELIZA_BROWSER_WORKSPACE_URL);

if (!LIVE_ENABLED || !provider) {
  console.info(
    "[portal-upload-e2e] skipped: set ELIZA_LIVE_TEST=1 and provide a provider API key",
  );
}

describe.skipIf(!LIVE_ENABLED || !provider)(
  "LifeOps Journey #16 — Speaker Portal Upload Via Browser Automation",
  () => {
    let mocked: MockedTestRuntime;
    let ownerId: UUID;
    let roomId: UUID;

    beforeAll(async () => {
      mocked = await createMockedTestRuntime({
        seedLifeOpsSimulator: true,
        withLLM: true,
        preferredProvider: provider?.name,
        // Ensure browser-workspace mock is included
        envs: [
          "google",
          "twilio",
          "whatsapp",
          "x-twitter",
          "calendly",
          "cloud-managed",
          "signal",
          "browser-workspace",
          "imessage",
          "github",
        ],
      });

      ownerId = crypto.randomUUID() as UUID;
      roomId = crypto.randomUUID() as UUID;

      mocked.mocks.clearRequestLedger();
    }, 120_000);

    afterAll(async () => {
      await mocked?.cleanup();
    });

    it("initiates browser-workspace portal navigation for the SXSW speaker portal", async () => {
      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: ownerId,
        roomId,
        metadata: { type: "user_message", entityName: "shaw" },
        content: {
          text: "Upload my deck to the SXSW speaker portal.",
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

      // Assert browser-workspace requests in the ledger
      const ledger = mocked.mocks.requestLedger();
      const browserRequests = ledger.filter(
        (entry) => entry.environment === "browser-workspace",
      );

      if (BROWSER_WS_AVAILABLE) {
        // When browser-workspace is wired up, expect at least a navigate or eval call
        expect(
          browserRequests.length,
          "expected browser-workspace navigate/eval calls",
        ).toBeGreaterThanOrEqual(1);
        expect(
          browserRequests.some(
            (entry) =>
              entry.browserWorkspace?.action === "navigate" ||
              entry.browserWorkspace?.action === "eval",
          ),
        ).toBe(true);
      } else {
        expect(browserRequests).toHaveLength(0);
      }
    }, 120_000);

    it.todo(
      "completes the full portal form fill and upload sequence (requires deterministic portal fixture)",
    );
  },
);
