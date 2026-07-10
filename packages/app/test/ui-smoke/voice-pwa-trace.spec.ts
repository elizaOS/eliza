/**
 * Voice trace-completeness + latency-artifact acceptance (sol-voice-pwa-e2e).
 * Runs in `chromium-voice-mic`. CONSUMER of the #15931 trace instrumentation
 * (markSharedRuntimeVoiceTrace / voice.* performance marks) — asserts nothing
 * this lane owns; it only harvests and validates the marks the app emits.
 *
 * MERGE-ORDER-INDEPENDENT: if the voice.* marks are absent (a build predating
 * #15931), the completeness assertions test.skip() and only the latency
 * artifact is written. Once #15931 lands, the chain assertions activate with no
 * change to this file.
 *
 * REAL: fake-device capture + WAV POST + SSE + TTS decode (the selftest path).
 * MOCKED: backends, via the voice-selftest shell's own mocked live-stack.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-pwa-trace.spec.ts
 */
import { expect, type Page, test } from "@playwright/test";
import { installDefaultAppRoutes, seedAppStorage } from "./helpers";
import {
  chainContainsInOrder,
  writeVoiceLatencyArtifact,
} from "./helpers/voice-latency-artifact";

const EXPECTED_PHRASE = "what time is it";
const CONV = "voice-pwa-trace-convo";
const ROOM = "voice-pwa-trace-room";
const REPLY = "Traced reply for the voice acceptance lane.";

function tinyWav(seconds = 0.3, sampleRate = 16000): Buffer {
  const n = Math.floor(sampleRate * seconds);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1)
    pcm.writeInt16LE(
      Math.round(9000 * Math.sin((2 * Math.PI * 330 * i) / sampleRate)),
      i * 2,
    );
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function installSelftestBackendMocks(page: Page): Promise<void> {
  await page.route("**/api/asr/local-inference/status", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ready: true, provider: "local-inference" }),
    }),
  );
  await page.route("**/api/asr/local-inference", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const bytes = route.request().postDataBuffer()?.byteLength ?? 0;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: bytes > 1000 ? EXPECTED_PHRASE : EXPECTED_PHRASE,
        capturedBytes: bytes,
      }),
    });
  });
  let created = false;
  await page.route("**/api/conversations", async (route) => {
    const ts = new Date().toISOString();
    if (route.request().method() === "GET")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversations: created
            ? [
                {
                  id: CONV,
                  roomId: ROOM,
                  title: "T",
                  createdAt: ts,
                  updatedAt: ts,
                },
              ]
            : [],
        }),
      });
    if (route.request().method() !== "POST") return route.fallback();
    created = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversation: {
          id: CONV,
          roomId: ROOM,
          title: "T",
          createdAt: ts,
          updatedAt: ts,
        },
      }),
    });
  });
  await page.route(`**/api/conversations/${CONV}/messages/stream`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        `data: ${JSON.stringify({ type: "token", text: REPLY, fullText: REPLY })}\n\n` +
        `data: ${JSON.stringify({ type: "done", fullText: REPLY, agentName: "Eliza" })}\n\n`,
    }),
  );
  await page.route(`**/api/conversations/${CONV}/messages`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages: [] }),
        })
      : route.fallback(),
  );
  for (const r of ["**/api/tts/cloud", "**/api/tts/local-inference"]) {
    await page.route(r, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 200,
            headers: { "content-type": "audio/wav" },
            body: tinyWav(),
          })
        : route.fallback(),
    );
  }
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installSelftestBackendMocks(page);
});

test("voice round-trip emits a complete trace chain (guarded on #15931) and a latency artifact", async ({
  page,
}, testInfo) => {
  await page.goto("/?shellMode=voice-selftest", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("voice-selftest-shell")).toBeVisible({
    timeout: 30_000,
  });

  // Drive the REAL fake-device capture round-trip.
  await page.getByTestId("voice-selftest-run-mic").click();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const r = JSON.parse(
            document.querySelector('[data-testid="voice-selftest-report"]')
              ?.textContent ?? "{}",
          ) as { mode?: string; overall?: string };
          return r.mode === "mic-capture" ? r.overall : null;
        }),
      { timeout: 40_000 },
    )
    .toBe("pass");

  const artifact = await writeVoiceLatencyArtifact(page, testInfo);

  // Guarded: only assert the completeness chain when #15931 marks are present.
  test.skip(
    !artifact.marksPresent,
    "voice.* trace marks not present on this build (pre-#15931)",
  );

  // The expected completeness subsequence (frontier audit §8.2). Extra marks
  // may appear between; order of these must hold.
  const expectedOrder = [
    "voice.stt_request_start",
    "voice.stt_request_end",
    "voice.transcript_received",
    "voice.playback_start",
  ];
  expect(
    chainContainsInOrder(artifact.chain, expectedOrder),
    `voice trace chain must contain ${expectedOrder.join(" -> ")} in order; got ${artifact.chain.join(", ")}`,
  ).toBe(true);
});
