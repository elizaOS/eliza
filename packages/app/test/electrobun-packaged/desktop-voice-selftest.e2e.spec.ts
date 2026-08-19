/**
 * Packaged Electrobun live-voice self-test.
 *
 * This is matrix-only: it is skipped from the broad packaged desktop suite
 * unless ELIZA_VOICE_DESKTOP_SELFTEST=1. When enabled, it launches the real
 * packaged desktop shell directly into ?shellMode=voice-selftest, points the
 * renderer at a real app-core API base, and requires the production
 * ASR -> agent SSE -> local TTS harness to report every stage as pass.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type TestInfo, test } from "@playwright/test";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";
import { assertCurrentPackagedRevision } from "./packaged-revision";

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
  startedAt: string;
  finishedAt: string;
  sendBackend?: string;
  stages: Array<{
    stage: string;
    status: string;
    detail?: Record<string, unknown>;
    error?: string;
  }>;
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
  revision: string;
  trajectory: unknown;
  sessionId: string;
  packagedRevision: string;
  rendererBuildId: string;
  microphoneBase64: string;
  referenceBase64: string;
  ttsBase64: string;
}): Promise<void> {
  const matrixOut = process.env.ELIZA_VOICE_MATRIX_OUT?.trim();
  const cellId = process.env.ELIZA_VOICE_MATRIX_CELL_ID?.trim();
  const evidenceDir = matrixOut
    ? path.join(matrixOut, slug(cellId || "desktop-voice-selftest"))
    : path.join(
        repoRoot,
        "test-results",
        "packaged-artifacts",
        "16937-voice-desktop-selftest",
      );
  await fs.mkdir(evidenceDir, { recursive: true });

  const prefix = `voice-desktop-selftest-${process.platform}`;
  const reportPath = path.join(evidenceDir, `${prefix}.json`);
  await fs.writeFile(
    reportPath,
    `${JSON.stringify(
      {
        revision: args.revision,
        sessionId: args.sessionId,
        packagedRevision: args.packagedRevision,
        rendererBuildId: args.rendererBuildId,
        capturedAt: new Date().toISOString(),
        report: args.report,
      },
      null,
      2,
    )}\n`,
  );
  await args.testInfo.attach("voice-desktop-selftest-report", {
    path: reportPath,
    contentType: "application/json",
  });

  const trajectoryPath = path.join(evidenceDir, `${prefix}-trajectory.json`);
  await fs.writeFile(
    trajectoryPath,
    `${JSON.stringify(args.trajectory, null, 2)}\n`,
  );
  await args.testInfo.attach("voice-desktop-live-trajectory", {
    path: trajectoryPath,
    contentType: "application/json",
  });

  for (const [suffix, encoded, contentType] of [
    ["input.wav", args.microphoneBase64, "audio/wav"],
    ["reference.wav", args.referenceBase64, "audio/wav"],
    ["tts.audio", args.ttsBase64, "application/octet-stream"],
  ] as const) {
    const artifactPath = path.join(evidenceDir, `${prefix}-${suffix}`);
    await fs.writeFile(artifactPath, Buffer.from(encoded, "base64"));
    await args.testInfo.attach(`voice-desktop-${suffix}`, {
      path: artifactPath,
      contentType,
    });
  }

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
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
    const sessionId = process.env.ELIZA_VOICE_CAPTURE_SESSION_ID?.trim() ?? "";
    expect(
      sessionId,
      "ELIZA_VOICE_CAPTURE_SESSION_ID must bind external hardware captures to this packaged run.",
    ).toMatch(/^[a-zA-Z0-9_.-]{12,128}$/);
    const microphoneDeviceId =
      process.env.ELIZA_VOICE_BROWSER_MIC_DEVICE_ID?.trim() ?? "";
    const speakerDeviceId =
      process.env.ELIZA_VOICE_BROWSER_SPEAKER_DEVICE_ID?.trim() ?? "";
    expect(microphoneDeviceId).not.toBe("");
    expect(speakerDeviceId).not.toBe("");
    expect(microphoneDeviceId).not.toBe(speakerDeviceId);

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-desktop-voice-selftest-"),
    );
    const launcherPath = await resolvePackagedLauncher(
      path.join(tempRoot, "extract"),
    );
    expect(
      launcherPath,
      "Packaged Electrobun launcher is required; build/redeploy the latest desktop app before capturing #16937 evidence.",
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
              EvalResult<{
                stamp: { buildId?: unknown; commit?: unknown } | null;
              }>
            >(
              `(() => ({ ok: true, stamp: window.__ELIZA_RENDERER_BUILD__ ?? null }))()`,
            ),
          {
            timeout: 30_000,
            message: "Expected the packaged renderer's embedded build stamp.",
          },
        )
        .toMatchObject({ ok: true, stamp: { buildId: expect.any(String) } });
      const rendererStampResult = await harness.eval<
        EvalResult<{ stamp: { buildId?: unknown; commit?: unknown } | null }>
      >(
        `(() => ({ ok: true, stamp: window.__ELIZA_RENDERER_BUILD__ ?? null }))()`,
      );
      expect(rendererStampResult.ok).toBe(true);
      if (!rendererStampResult.ok) return;
      const packagedRevision = assertCurrentPackagedRevision(
        rendererStampResult.stamp,
        revision,
      );

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
          const report = await run({
            mode: "mic-capture",
            microphoneDeviceId: ${JSON.stringify(microphoneDeviceId)},
            speakerDeviceId: ${JSON.stringify(speakerDeviceId)},
          });
          return { ok: true, report };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })()`);

      expect(result.ok, result.ok ? undefined : result.error).toBe(true);
      if (!result.ok) {
        return;
      }

      const trajectoryResult = await harness.eval<
        EvalResult<{ trajectory: unknown }>
      >(`(async () => {
        try {
          const report = JSON.parse(document.querySelector('[data-testid="voice-selftest-report"]')?.textContent || '{}');
          const send = report.stages?.find((stage) => stage.stage === 'send');
          const conversationId = send?.detail?.conversationId;
          const userMessageId = send?.detail?.userMessageId;
          if (typeof conversationId !== 'string') throw new Error('missing SEND conversation id');
          if (typeof userMessageId !== 'string') throw new Error('missing SEND user message id');
          const conversationsResponse = await fetch('/api/conversations');
          if (!conversationsResponse.ok) throw new Error('conversation list HTTP ' + conversationsResponse.status);
          const conversations = await conversationsResponse.json();
          const roomId = conversations.conversations?.find((item) => item.id === conversationId)?.roomId;
          if (typeof roomId !== 'string') throw new Error('missing conversation room id');
          const listResponse = await fetch('/api/trajectories?limit=50');
          if (!listResponse.ok) throw new Error('trajectory list HTTP ' + listResponse.status);
          const list = await listResponse.json();
          const startedAt = Date.parse(report.startedAt);
          const matches = (list.trajectories || []).filter((item) =>
            item.roomId === roomId &&
            item.conversationId === conversationId &&
            item.metadata?.messageId === userMessageId &&
            item.startTime >= startedAt &&
            item.llmCallCount > 0
          );
          if (matches.length !== 1) throw new Error('expected one conversation-correlated trajectory, found ' + matches.length);
          const detailResponse = await fetch('/api/trajectories/' + encodeURIComponent(matches[0].id));
          if (!detailResponse.ok) throw new Error('trajectory detail HTTP ' + detailResponse.status);
          const trajectory = await detailResponse.json();
          if (trajectory.trajectory?.id !== matches[0].id) throw new Error('trajectory detail id mismatch');
          if (trajectory.trajectory?.metadata?.conversationId !== conversationId) throw new Error('trajectory conversation id mismatch');
          if (trajectory.trajectory?.metadata?.messageId !== userMessageId) throw new Error('trajectory user message id mismatch');
          return { ok: true, trajectory };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })()`);
      expect(
        trajectoryResult.ok,
        trajectoryResult.ok ? undefined : trajectoryResult.error,
      ).toBe(true);
      if (!trajectoryResult.ok) return;

      const artifactResult = await harness.eval<
        EvalResult<{
          microphoneBase64: string;
          referenceBase64: string;
          ttsBase64: string;
        }>
      >(`(() => {
        try {
          const artifacts = window.__voiceSelfTestArtifacts?.();
          if (
            !artifacts?.microphoneBase64 ||
            !artifacts?.referenceBase64 ||
            !artifacts?.ttsBase64
          ) {
            throw new Error('voice self-test payload artifacts are missing');
          }
          return { ok: true, ...artifacts };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })()`);
      expect(
        artifactResult.ok,
        artifactResult.ok ? undefined : artifactResult.error,
      ).toBe(true);
      if (!artifactResult.ok) return;

      await writeEvidence({
        testInfo,
        harness,
        report: result.report,
        revision,
        trajectory: trajectoryResult.trajectory,
        sessionId,
        packagedRevision: packagedRevision.commit,
        rendererBuildId: packagedRevision.buildId,
        microphoneBase64: artifactResult.microphoneBase64,
        referenceBase64: artifactResult.referenceBase64,
        ttsBase64: artifactResult.ttsBase64,
      });

      expect(
        result.report.overall,
        `voice self-test stages: ${JSON.stringify(result.report.stages)}`,
      ).toBe("pass");
      expect(result.report.platform).toBe("desktop");
      expect(result.report.mode).toBe("mic-capture");
      expect(result.report.ttsRoute).toBe("/api/tts/local-inference");
      expect(result.report.sendBackend).toMatch(/^local-inference:/);
      const byStage = Object.fromEntries(
        result.report.stages.map((stage) => [stage.stage, stage.status]),
      );
      expect(byStage.asr).toBe("pass");
      expect(byStage.send).toBe("pass");
      expect(byStage.tts).toBe("pass");
      const tts = result.report.stages.find((stage) => stage.stage === "tts");
      expect(tts?.detail?.played).toBe(true);
      expect(tts?.detail?.outputObserved).toBe(true);
      expect(tts?.detail?.outputDeviceId).toBe(speakerDeviceId);
      const asr = result.report.stages.find((stage) => stage.stage === "asr");
      expect(asr?.detail?.inputDeviceId).toBe(microphoneDeviceId);
      expect(result.report.transcript.toLowerCase()).toContain("time");
      expect(result.report.reply.length).toBeGreaterThan(0);
    } finally {
      // error-policy:J6 the assertions and harness logs retain the primary
      // failure; teardown must still attempt to release the packaged process.
      await harness?.stop().catch(() => undefined);
    }
  });
});
