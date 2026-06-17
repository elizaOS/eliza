// REAL on-device voice round-trip on the physical Pixel 9a — NO mocks, NO human.
//
// Drives the self-driving voice self-test screen (?shellMode=voice-selftest) in
// the actual Capacitor WebView against the REAL on-device agent: the harness
// fetches a real omnivoice.cpp speech clip ("what time is it"), POSTs it to the
// REAL on-device local-inference ASR, sends the transcript to the REAL agent
// over SSE, and synthesizes the reply via the REAL on-device TTS — then asserts
// a machine-readable overall=pass. This is the genuine voice-in -> auto-verify
// loop the goal asks for, exercised end-to-end on real hardware.
//
// Requires the app rebuilt with the voice-selftest screen + RECORD_AUDIO granted
// (global-setup pre-grants it). If the on-device ASR is not provisioned the ASR
// stage reports `skipped` (not `pass`), so this fails loudly rather than
// false-greening.
import { resolveAdb } from "../../scripts/lib/android-device.mjs";
import { expect, ORIGIN, test } from "./android-harness";

test.describe("android on-device voice round-trip (real backend)", () => {
  test("voice self-test reports overall=pass via the real on-device STT->agent->TTS loop", async ({
    page,
    device,
  }) => {
    // Make sure mic permission is granted for the native capture path.
    const adb = resolveAdb();
    for (const perm of [
      "android.permission.RECORD_AUDIO",
      "android.permission.MODIFY_AUDIO_SETTINGS",
    ]) {
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync(adb, [
          "-s",
          device.serial(),
          "shell",
          "pm",
          "grant",
          "ai.elizaos.app",
          perm,
        ]);
      } catch {
        // Some permissions are normal (auto-granted) — ignore grant failures.
      }
    }

    // Load the self-test screen. The shell reads ?shellMode= at boot, so we
    // navigate the WebView to the root with the query (Capacitor serves
    // index.html for the root path).
    await page.goto(`${ORIGIN}/?shellMode=voice-selftest`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(page.getByTestId("voice-selftest-shell")).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __voiceSelfTest?: unknown })
          .__voiceSelfTest === "function",
      { timeout: 60_000 },
    );

    // Reclaim cached background apps *immediately* before the round-trip. The
    // turn cold-loads the ~1.4 GB ASR model and the ~0.66 GB omnivoice TTS model
    // on top of the resident chat model; on a memory-tight phone the load spikes
    // trip lmkd's low watermark and the detached bun agent (which an unprivileged
    // app cannot oom-protect) becomes the kill target. global-setup frees memory
    // once at boot, but Google services respawn before TTS loads — freeing here,
    // right before the heavy work, gives the agent the headroom when it matters.
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync(adb, ["-s", device.serial(), "shell", "am", "kill-all"]);
    } catch {
      // Best-effort headroom; proceed even if the reclaim command is unavailable.
    }

    // Drive the real harness. wav-direct: the bundled real omnivoice clip ->
    // real on-device ASR -> real agent SSE -> real on-device TTS decode.
    const report = await page.evaluate(
      async () =>
        await (
          window as unknown as {
            __voiceSelfTest: (o?: { mode?: string }) => Promise<{
              overall: string;
              transcript: string;
              reply: string;
              stages: Array<{ stage: string; status: string; error?: string }>;
            }>;
          }
        ).__voiceSelfTest({ mode: "wav-direct" }),
    );

    // Fail loudly with the full per-stage report if anything regressed.
    expect(
      report.overall,
      `on-device voice round-trip not green: ${JSON.stringify(report.stages)}`,
    ).toBe("pass");
    const byStage = Object.fromEntries(
      report.stages.map((s) => [s.stage, s.status]),
    );
    expect(byStage.asr, "real on-device ASR must transcribe the clip").toBe(
      "pass",
    );
    expect(byStage.send, "real agent must reply over SSE").toBe("pass");
    expect(byStage.tts, "real on-device TTS must produce decodable audio").toBe(
      "pass",
    );
    expect(report.transcript.toLowerCase()).toContain("time");
    expect(report.reply.length).toBeGreaterThan(0);
  });
});
