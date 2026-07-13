// QS-tile / launcher-shortcut intent spine on the REAL Android WebView. Fires
// the exact elizaos:// deep links the native surfaces mint — ElizaChatTile/
// ElizaVoiceTile/ElizaTranscribeTileService (source=android-qs-tile) and the
// static shortcuts in shortcuts.xml (source=android-app-actions) — via
// `adb shell am start` (the same VIEW+BROWSABLE delivery the OS uses), and
// asserts the renderer actually enters the promised state: transcribe=1 flips
// the composer transcribe control to "stop transcription", voice=1 flips the
// mic to "end conversation", and a successful claim consumes the launch params
// off the hash. The forged-source case proves the security half: an untrusted
// source must NOT start capture and must NOT be claimed.
//
// Requires the standard android lane bring-up (scripts/android-e2e.mjs): app
// installed with ELIZA_WEBVIEW_DEBUG=1, agent reachable, RECORD_AUDIO grantable.
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { APP_ID, resolveAdb } from "../../scripts/lib/android-device.mjs";
import { expect, test } from "./android-harness";

const TILE_TRANSCRIBE_URI = "elizaos://transcribe?source=android-qs-tile";
const TILE_VOICE_URI = "elizaos://voice?source=android-qs-tile";
const SHORTCUT_TRANSCRIBE_URI =
  "elizaos://transcribe?source=android-app-actions";
const FORGED_VOICE_URI = "elizaos://voice?source=forged-untrusted";

function startDeepLink(adb: string, serial: string, url: string): void {
  execFileSync(
    adb,
    [
      "-s",
      serial,
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-c",
      "android.intent.category.BROWSABLE",
      "-d",
      url,
      APP_ID,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
}

async function composerControlLabel(
  page: Page,
  testId: string,
): Promise<string> {
  return page
    .evaluate(
      (id: string) =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.getAttribute("aria-label") ?? "",
      testId,
    )
    .catch(() => "");
}

/** Poll a composer control's aria-label until it reads `expected`. */
async function expectControlLabel(
  page: Page,
  testId: string,
  expected: string,
  message: string,
  timeoutMs = 60_000,
): Promise<void> {
  await expect
    .poll(() => composerControlLabel(page, testId), {
      timeout: timeoutMs,
      message,
    })
    .toBe(expected);
}

/**
 * End any live capture through the master voice control (a mic tap ends
 * transcription AND the mic) and clear any transcript that landed in the
 * draft, so each test starts from a quiet composer.
 */
async function quiesceComposer(page: Page): Promise<void> {
  const micLabel = await composerControlLabel(page, "chat-composer-mic");
  if (micLabel && micLabel !== "talk") {
    await page.getByTestId("chat-composer-mic").click();
    await expectControlLabel(
      page,
      "chat-composer-mic",
      "talk",
      "master mic tap must end the live capture session",
    );
  }
  // A stopped transcription drops its transcript at the end of the draft; a
  // draft swaps the mic slot to send, which would hide the controls the next
  // test asserts on.
  await page
    .evaluate(() => {
      const composer = document.querySelector(
        '[aria-label="message"]',
      ) as HTMLTextAreaElement | null;
      if (composer?.value) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        setter?.call(composer, "");
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
    })
    .catch(() => {});
}

test.describe("android assistant intents (QS tiles + static shortcuts)", () => {
  test.beforeAll(async ({ device }) => {
    // Capture launches start the real microphone path; pre-grant like the
    // voice self-test lane so the permission prompt never wedges the flow.
    const adb = resolveAdb();
    for (const perm of [
      "android.permission.RECORD_AUDIO",
      "android.permission.MODIFY_AUDIO_SETTINGS",
    ]) {
      try {
        execFileSync(adb, [
          "-s",
          device.serial(),
          "shell",
          "pm",
          "grant",
          APP_ID,
          perm,
        ]);
      } catch {
        // Auto-granted permissions reject the explicit grant — that's fine.
      }
    }
  });

  test.beforeEach(async ({ page }) => {
    await quiesceComposer(page);
  });

  test("transcribe tile deep link enters transcription mode and consumes the launch", async ({
    page,
    device,
  }) => {
    startDeepLink(resolveAdb(), device.serial(), TILE_TRANSCRIBE_URI);

    await expectControlLabel(
      page,
      "chat-composer-transcribe",
      "stop transcription",
      `${TILE_TRANSCRIBE_URI} must start transcription mode (composer control flips to stop)`,
    );
    // A claimed launch strips its params off the hash; params left behind mean
    // the payload was never claimed and the mode flip came from elsewhere.
    await expect
      .poll(() => page.evaluate(() => window.location.hash), {
        message: "claimed transcribe launch must consume its hash params",
      })
      .toBe("#chat");

    await quiesceComposer(page);
    await expectControlLabel(
      page,
      "chat-composer-transcribe",
      "start transcription",
      "transcription must end after the master mic tap",
    );
  });

  test("voice tile deep link starts hands-free capture", async ({
    page,
    device,
  }) => {
    startDeepLink(resolveAdb(), device.serial(), TILE_VOICE_URI);

    await expectControlLabel(
      page,
      "chat-composer-mic",
      "end conversation",
      `${TILE_VOICE_URI} must start hands-free capture (mic flips to end conversation)`,
    );
    await expect
      .poll(() => page.evaluate(() => window.location.hash), {
        message: "claimed voice launch must consume its hash params",
      })
      .toBe("#chat");

    await quiesceComposer(page);
  });

  test("transcribe static-shortcut deep link also enters transcription mode", async ({
    page,
    device,
  }) => {
    // Same renderer path as the tile, different trusted source — this is the
    // exact data URI shortcuts.xml binds for App Actions / launcher long-press.
    startDeepLink(resolveAdb(), device.serial(), SHORTCUT_TRANSCRIBE_URI);

    await expectControlLabel(
      page,
      "chat-composer-transcribe",
      "stop transcription",
      `${SHORTCUT_TRANSCRIBE_URI} must start transcription mode`,
    );

    await quiesceComposer(page);
  });

  test("forged-source voice deep link neither starts capture nor claims the launch", async ({
    page,
    device,
  }) => {
    startDeepLink(resolveAdb(), device.serial(), FORGED_VOICE_URI);

    // Give the renderer time to (wrongly) act, then assert it did not: the mic
    // stays idle and the untrusted params stay unclaimed on the hash.
    await page.waitForTimeout(8_000);
    expect(
      await composerControlLabel(page, "chat-composer-mic"),
      "an untrusted source must never start voice capture",
    ).toBe("talk");
    expect(
      await composerControlLabel(page, "chat-composer-transcribe"),
      "an untrusted source must never start transcription",
    ).toBe("start transcription");
    const hash = await page.evaluate(() => window.location.hash);
    expect(
      hash,
      "an unclaimed launch must leave its params on the hash (claim gate rejected it)",
    ).toContain("forged-untrusted");

    // Leave a clean hash for whatever spec runs next.
    await page.evaluate(() => {
      window.history.replaceState(null, "", "#chat");
    });
  });
});
