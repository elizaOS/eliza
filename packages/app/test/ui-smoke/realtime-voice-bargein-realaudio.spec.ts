/**
 * Opt-in live acoustic-interruption proof for the normal-chat Talk surface.
 *
 * The dedicated Chromium project feeds two committed real-speech clips with a
 * 1.3-second gap, after semantic EOT but during measured local playout. No STT,
 * agent, TTS, WebSocket, or playback mock is installed; CI skips this unless a
 * developer explicitly enables live voice.
 */

import { expect, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const LIVE = process.env.ELIZA_REALTIME_VOICE_LOCAL_LIVE === "1";

test.describe("normal-chat realtime acoustic barge-in", () => {
  test.skip(
    !LIVE,
    "set ELIZA_REALTIME_VOICE_LOCAL_LIVE=1 with the local gateway running",
  );

  test("confirmed speech flushes old browser playout and the replacement completes", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    const consoleMessages: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => consoleMessages.push(message.text()));
    await page.addInitScript(() => {
      Object.defineProperty(window, "BroadcastChannel", {
        configurable: true,
        value: undefined,
      });
    });

    const createResponse = await page.request.post("/api/conversations", {
      data: {
        title: `realtime-voice-barge-live-${Date.now()}`,
        metadata: { scope: "general" },
      },
    });
    const createText = await createResponse.text();
    expect(
      createResponse.ok(),
      `local runtime should create the barge-in room (status=${createResponse.status()}, body=${createText.slice(0, 500)})`,
    ).toBe(true);
    const conversationId = (
      JSON.parse(createText) as { conversation?: { id?: string } }
    ).conversation?.id?.trim();
    expect(conversationId, "created barge-in conversation id").toBeTruthy();
    if (!conversationId) throw new Error("missing barge-in conversation id");

    const importResponse = await page.request.post(
      `/api/conversations/${encodeURIComponent(conversationId)}/import`,
      {
        data: {
          messages: [
            {
              role: "user",
              text: [
                "Realtime acoustic interruption live-proof setup.",
                "For this conversation, whenever I ask what time it is,",
                "first count slowly from one through ten and then state the time.",
              ].join(" "),
              timestamp: Date.now(),
              sourceId: `voice-live-barge-bootstrap:${conversationId}`,
            },
          ],
        },
      },
    );
    const importText = await importResponse.text();
    expect(
      importResponse.ok(),
      `barge-in room should accept its no-inference setup (status=${importResponse.status()}, body=${importText.slice(0, 500)})`,
    ).toBe(true);

    await seedAppStorage(page, {
      "eliza:chat:activeConversationId": conversationId,
      "eliza:voice:debug": "1",
    });
    await page.addInitScript((id) => {
      localStorage.setItem("eliza:chat:activeConversationId", id);
    }, conversationId);
    await openAppPath(page, "/chat");
    await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
      "data-conversation-id",
      conversationId,
      { timeout: 60_000 },
    );

    const mic = page.getByTestId("chat-composer-mic");
    await expect(mic).toHaveAttribute("aria-label", "talk", {
      timeout: 45_000,
    });
    const knownPhraseTurns = page
      .getByRole("region", { name: "conversation history" })
      .getByText("What time is it?", { exact: true });
    const userMessageRows = page.locator(
      '[data-testid="thread-line"][data-role="user"]',
    );
    const assistantMessageRows = page.locator(
      '[data-testid="thread-line"][data-role="assistant"]',
    );
    await expect(knownPhraseTurns).toHaveCount(0);

    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", "end conversation", {
      timeout: 45_000,
    });

    try {
      // Start this guard immediately: whether or not the interruption contract
      // passes, mute after the second authoritative transcript so Chromium can
      // never loop the scenario and contaminate later local turns.
      const muteAfterSecondTurn = (async () => {
        await expect
          .poll(() => knownPhraseTurns.count(), { timeout: 30_000 })
          .toBe(2);
        const mute = page.getByRole("button", { name: "mute microphone" });
        await mute.click();
        await expect(
          page.getByRole("button", { name: "unmute microphone" }),
        ).toBeVisible({ timeout: 15_000 });
      })();
      const playbackStartedLine = page
        .getByTestId("voice-capture-hud-line")
        .filter({ hasText: "realtime:playback-started" })
        .last();
      await expect(playbackStartedLine).toBeVisible({ timeout: 90_000 });

      // Streaming audio can evict these short-lived marks from the 12-line HUD
      // before a locator observes them. Debug logging retains the same
      // content-free breadcrumbs for the whole run. Require immediate local
      // provisional pause followed by sustained local confirmation; a slower
      // provider partial must not let stale audio resume over real speech.
      await expect
        .poll(
          () =>
            consoleMessages.some((message) =>
              message.includes(
                "[eliza][voice-capture] realtime:local_speech_start",
              ),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            consoleMessages.some((message) =>
              message.includes(
                "[eliza][voice-capture] realtime:local_speech_start_confirmed",
              ),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      expect(
        consoleMessages.some((message) =>
          message.includes(
            "[eliza][voice-capture] realtime:local_speech_start_unconfirmed",
          ),
        ),
      ).toBe(false);
      await muteAfterSecondTurn;

      const replacementTraceLine = page
        .getByTestId("voice-capture-hud-line")
        .filter({ hasText: "realtime:trace-complete" })
        .filter({ hasText: "spoken" })
        .last();
      await expect(replacementTraceLine).toContainText("evidence:complete", {
        timeout: 150_000,
      });
      await expect(userMessageRows).toHaveCount(3);
      await expect
        .poll(() => assistantMessageRows.count())
        .toBeGreaterThanOrEqual(1);
      expect(await assistantMessageRows.count()).toBeLessThanOrEqual(2);
      expect(pageErrors).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath("normal-chat-realtime-barge-live.png"),
        fullPage: true,
      });
    } finally {
      if (
        !page.isClosed() &&
        (await mic.getAttribute("aria-label")) === "end conversation"
      ) {
        await mic.click();
        await expect(mic).toHaveAttribute("aria-label", "talk", {
          timeout: 30_000,
        });
      }
    }
  });
});
