/**
 * Opt-in local live proof for the normal-chat realtime Talk surface.
 *
 * Chromium receives the committed known-phrase WAV as its microphone through
 * the `chromium-voice-mic` project. Unlike the keyless batch-voice suite, this
 * test does not mock STT, the agent, TTS, or the voice WebSocket. It requires
 * the developer's already-running local API and Cartesia gateway and is gated
 * so CI can never mistake an unavailable provider for a passing mock.
 */

import { expect, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const LIVE = process.env.ELIZA_REALTIME_VOICE_LOCAL_LIVE === "1";

test.describe("normal-chat realtime voice with real browser audio", () => {
  test.skip(
    !LIVE,
    "set ELIZA_REALTIME_VOICE_LOCAL_LIVE=1 with the local gateway running",
  );

  test("Talk drives real Ink, local agent, Sonic, playout, and strict HUD evidence", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    // The developer can keep the same-origin preview open while this opt-in
    // proof runs. Prevent its tab-sync channel from switching this page away
    // from the isolated conversation; voice still uses the real WebSocket.
    await page.addInitScript(() => {
      Object.defineProperty(window, "BroadcastChannel", {
        configurable: true,
        value: undefined,
      });
    });

    const createConversationResponse = await page.request.post(
      "/api/conversations",
      {
        data: {
          title: `realtime-voice-live-${Date.now()}`,
          metadata: { scope: "general" },
        },
      },
    );
    const createConversationText = await createConversationResponse.text();
    expect(
      createConversationResponse.ok(),
      `local runtime should create an isolated voice conversation (status=${createConversationResponse.status()}, body=${createConversationText.slice(0, 500)})`,
    ).toBe(true);
    const createdConversation = JSON.parse(createConversationText) as {
      conversation?: { id?: string };
    };
    const conversationId = createdConversation.conversation?.id?.trim();
    expect(conversationId, "created voice conversation id").toBeTruthy();
    if (!conversationId) {
      throw new Error("local runtime did not return a voice conversation id");
    }
    await expect
      .poll(async () => {
        const listResponse = await page.request.get("/api/conversations");
        if (!listResponse.ok()) return false;
        const list = (await listResponse.json()) as {
          conversations?: Array<{ id?: string }>;
        };
        return Boolean(
          list.conversations?.some(
            (conversation) => conversation.id === conversationId,
          ),
        );
      })
      .toBe(true);
    const importResponse = await page.request.post(
      `/api/conversations/${encodeURIComponent(conversationId)}/import`,
      {
        data: {
          messages: [
            {
              role: "user",
              text: "Realtime voice live-proof setup.",
              timestamp: Date.now(),
              sourceId: `voice-live-proof-bootstrap:${conversationId}`,
            },
          ],
        },
      },
    );
    const importText = await importResponse.text();
    expect(
      importResponse.ok(),
      `isolated voice conversation should accept its no-inference bootstrap message (status=${importResponse.status()}, body=${importText.slice(0, 500)})`,
    ).toBe(true);

    await seedAppStorage(page, {
      "eliza:chat:activeConversationId": conversationId,
    });
    // This test can run after other live smoke specs in the same browser
    // project. Make the isolated room selection unconditional at document
    // start even if a prior helper already installed its one-shot seed guard.
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
    await expect(mic).toBeVisible({ timeout: 45_000 });
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
      // Chromium loops --use-file-for-fake-audio-capture forever. Mute the
      // uplink after the first authoritative Ink final so the fixture cannot
      // barge into its own answer; silence packets continue so the normal hot
      // session and exact browser playout path remain exercised.
      // The durable user bubble is the end-user proof of authoritative STT.
      // HUD rows intentionally use a bounded ring and can evict stt_final if
      // a fake-capture loop produces later diagnostics before this waiter runs.
      await expect
        .poll(() => knownPhraseTurns.count(), { timeout: 90_000 })
        .toBeGreaterThan(0);
      const mute = page.getByRole("button", { name: "mute microphone" });
      await mute.click();
      await expect(
        page.getByRole("button", { name: "unmute microphone" }),
      ).toBeVisible({ timeout: 15_000 });

      const completedLine = page
        .getByTestId("voice-capture-hud-line")
        .filter({ hasText: "realtime:trace-complete" })
        .last();
      await expect(completedLine).toContainText("spoken", {
        timeout: 150_000,
      });
      await expect(completedLine).toContainText("evidence:complete", {
        timeout: 150_000,
      });
      await expect(completedLine).toContainText("E→STT", {
        timeout: 150_000,
      });
      await expect(completedLine).toContainText("C→M", { timeout: 150_000 });
      await expect(completedLine).toContainText("S→TTS", {
        timeout: 150_000,
      });
      await expect(completedLine).toContainText("E→A", { timeout: 150_000 });
      await expect(userMessageRows).toHaveCount(2);
      await expect(assistantMessageRows).toHaveCount(1);

      await page.screenshot({
        path: testInfo.outputPath("normal-chat-realtime-live.png"),
        fullPage: true,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      // Never leave the hot fake microphone running after a failed assertion.
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
