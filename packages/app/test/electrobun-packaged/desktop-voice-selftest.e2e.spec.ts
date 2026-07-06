/**
 * Packaged Electrobun live-voice self-test.
 *
 * This is matrix-only: it is skipped from the broad packaged desktop suite
 * unless ELIZA_VOICE_DESKTOP_SELFTEST=1. When enabled, it launches the real
 * packaged desktop shell directly into ?shellMode=voice-selftest, points the
 * renderer at a real app-core API base, and requires the production
 * ASR -> agent SSE -> local TTS harness to report every stage as pass.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type TestInfo, test } from "@playwright/test";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

type EvalOk<T> = T & { ok: true };
type EvalErr = { ok: false; error: string };
type EvalResult<T> = EvalOk<T> | EvalErr;

interface VoiceSelfTestReport {
  overall: "pass" | "fail" | "skipped";
  platform: string;
  mode: string;
  ttsRoute: string;
  transcript: string;
  reply: string;
  stages: Array<{ stage: string; status: string; error?: string }>;
}

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

function desktopVoiceSelfTestEnabled(): boolean {
  return process.env.ELIZA_VOICE_DESKTOP_SELFTEST === "1";
}

function resolveVoiceApiBase(): string {
  return (
    process.env.ELIZA_VOICE_DESKTOP_API_BASE?.trim() ??
    process.env.ELIZA_DESKTOP_TEST_API_BASE?.trim() ??
    ""
  );
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "");
}

async function writeEvidence(args: {
  testInfo: TestInfo;
  harness: PackagedDesktopHarness;
  report: VoiceSelfTestReport;
}): Promise<void> {
  const matrixOut = process.env.ELIZA_VOICE_MATRIX_OUT?.trim();
  const cellId = process.env.ELIZA_VOICE_MATRIX_CELL_ID?.trim();
  const evidenceDir = matrixOut
    ? path.join(matrixOut, slug(cellId || "desktop-voice-selftest"))
    : path.join(
        repoRoot,
        "test-results",
        "packaged-artifacts",
        "9958-voice-desktop-selftest",
      );
  await fs.mkdir(evidenceDir, { recursive: true });

  const prefix = `voice-desktop-selftest-${process.platform}`;
  const reportPath = path.join(evidenceDir, `${prefix}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(args.report, null, 2)}\n`);
  await args.testInfo.attach("voice-desktop-selftest-report", {
    path: reportPath,
    contentType: "application/json",
  });

  const logPath = path.join(evidenceDir, `${prefix}.log`);
  await fs.writeFile(
    logPath,
    [
      "App stdout:",
      args.harness.logs?.stdout.join("") ?? "",
      "",
      "App stderr:",
      args.harness.logs?.stderr.join("") ?? "",
    ].join("\n"),
  );
  await args.testInfo.attach("voice-desktop-selftest-log", {
    path: logPath,
    contentType: "text/plain",
  });

  const data = await args.harness.screenshot();
  const pngPath = path.join(evidenceDir, `${prefix}.png`);
  await fs.writeFile(
    pngPath,
    Buffer.from(data.replace(/^data:image\/png;base64,/, ""), "base64"),
  );
  await args.testInfo.attach("voice-desktop-selftest-screenshot", {
    path: pngPath,
    contentType: "image/png",
  });
}

test.describe("packaged desktop live voice self-test", () => {
  test.skip(
    !desktopVoiceSelfTestEnabled(),
    "matrix-only; set ELIZA_VOICE_DESKTOP_SELFTEST=1 from voice:matrix",
  );

  test("reports pass against a real desktop API base and local TTS route", async ({
    browserName: _browserName,
  }, testInfo) => {
    void _browserName;
    test.setTimeout(600_000);

    const apiBase = resolveVoiceApiBase();
    expect(
      apiBase,
      "ELIZA_VOICE_DESKTOP_API_BASE must point at a real app-core API base for live desktop voice evidence.",
    ).toMatch(/^https?:\/\//);

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-desktop-voice-selftest-"),
    );
    const launcherPath = await resolvePackagedLauncher(
      path.join(tempRoot, "extract"),
    );
    expect(
      launcherPath,
      "Packaged Electrobun launcher is required; build/redeploy the latest desktop app before capturing #9958 evidence.",
    ).toBeTruthy();

    let harness: PackagedDesktopHarness | null = null;
    try {
      harness = new PackagedDesktopHarness({
        tempRoot,
        launcherPath: launcherPath as string,
        apiBase,
        extraEnv: {
          ELIZAOS_SHELL_MODE: "voice-selftest",
        },
      });

      await harness.start({
        bridgeHealthTimeoutMs: 300_000,
        shellReadyTimeoutMs: 120_000,
      });
      await harness.setMainWindowBounds({
        x: 0,
        y: 0,
        width: 1240,
        height: 860,
      });
      await harness.showMainWindow();
      await harness.focusMainWindow();

      await expect
        .poll(
          async () =>
            await harness?.eval<
              EvalResult<{ ready: boolean; overall: string | null }>
            >(`(() => {
              try {
                const shell = document.querySelector('[data-testid="voice-selftest-shell"]');
                const overall = shell?.getAttribute("data-overall") ?? null;
                return {
                  ok: true,
                  ready: Boolean(shell) && typeof window.__voiceSelfTest === "function",
                  overall,
                };
              } catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
              }
            })()`),
          {
            timeout: 120_000,
            message:
              "Expected packaged desktop to boot into voice-selftest shell.",
          },
        )
        .toMatchObject({ ok: true, ready: true });

      const result = await harness.eval<
        EvalResult<{ report: VoiceSelfTestReport }>
      >(`(async () => {
        try {
          const run = window.__voiceSelfTest;
          if (typeof run !== "function") {
            return { ok: false, error: "__voiceSelfTest is not installed" };
          }
          const report = await run({ mode: "wav-direct" });
          return { ok: true, report };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })()`);

      expect(result.ok, result.ok ? undefined : result.error).toBe(true);
      if (!result.ok) {
        return;
      }

      await writeEvidence({
        testInfo,
        harness,
        report: result.report,
      });

      expect(
        result.report.overall,
        `voice self-test stages: ${JSON.stringify(result.report.stages)}`,
      ).toBe("pass");
      expect(result.report.platform).toBe("desktop");
      expect(result.report.ttsRoute).toBe("/api/tts/local-inference");
      const byStage = Object.fromEntries(
        result.report.stages.map((stage) => [stage.stage, stage.status]),
      );
      expect(byStage.asr).toBe("pass");
      expect(byStage.send).toBe("pass");
      expect(byStage.tts).toBe("pass");
      expect(result.report.transcript.toLowerCase()).toContain("time");
      expect(result.report.reply.length).toBeGreaterThan(0);
    } finally {
      await harness?.stop().catch(() => undefined);
    }
  });
});
