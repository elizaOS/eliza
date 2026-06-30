import fs from "node:fs";
import path from "node:path";
import {
  captureAndroidLogcat,
  captureAndroidScreenshot,
  startAndroidScreenRecord,
} from "../../scripts/lib/android-capture.mjs";
import { adbDevice, resolveAdb } from "../../scripts/lib/android-device.mjs";
import { expect, test, waitForShellReady } from "./android-harness";

const ARTIFACT_DIR = path.join(
  process.cwd(),
  "test-results",
  "android-agent-restart",
);

type AgentRequestResult = {
  status: number;
  statusText?: string;
  body?: string;
};

type HealthSnapshot = {
  status: number;
  ready?: boolean;
  agentState?: string;
  body: unknown;
};

async function requestAgentHealth(): Promise<HealthSnapshot> {
  let result: AgentRequestResult;
  try {
    result = (await window.Capacitor?.Plugins?.Agent?.request({
      method: "GET",
      path: "/api/health",
      timeoutMs: 10_000,
    })) as AgentRequestResult;
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    };
  }

  let body: unknown = result.body ?? "";
  if (typeof result.body === "string" && result.body.trim()) {
    try {
      body = JSON.parse(result.body);
    } catch {
      body = result.body;
    }
  }

  const parsed = typeof body === "object" && body !== null ? body : {};
  return {
    status: result.status,
    ready: (parsed as { ready?: boolean }).ready,
    agentState: (parsed as { agentState?: string }).agentState,
    body,
  };
}

test.describe
  .serial("android agent crash/restart recovery", () => {
    test("recovers the on-device local agent after a debug crash", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(720_000);

      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      const adb = resolveAdb();
      const serial = device.serial();
      const consoleLines: string[] = [];
      const pageErrors: string[] = [];
      const healthSamples: Array<{
        phase: string;
        observedAt: string;
        health: HealthSnapshot;
      }> = [];

      adbDevice(adb, serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
      adbDevice(adb, serial, ["shell", "wm", "dismiss-keyguard"]);

      page.on("console", (message) => {
        consoleLines.push(
          JSON.stringify({
            type: message.type(),
            text: message.text(),
          }),
        );
      });
      page.on("pageerror", (error) => {
        pageErrors.push(error.stack || error.message);
      });

      const recording = await startAndroidScreenRecord({
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "android-agent-restart.mp4",
        remotePath: "/sdcard/eliza-android-agent-restart.mp4",
        timeLimitSeconds: 720,
      });

      try {
        await waitForShellReady(page);

        let baseline = await page.evaluate(requestAgentHealth);
        await expect
          .poll(
            async () => {
              baseline = await page.evaluate(requestAgentHealth);
              healthSamples.push({
                phase: "baseline-poll",
                observedAt: new Date().toISOString(),
                health: baseline,
              });
              return baseline.status === 200 && baseline.ready !== false;
            },
            {
              timeout: 480_000,
              intervals: [1000, 2000, 5000],
              message: "on-device local agent did not become healthy",
            },
          )
          .toBe(true);

        healthSamples.push({
          phase: "baseline",
          observedAt: new Date().toISOString(),
          health: baseline,
        });
        expect(
          baseline.status,
          `baseline health: ${JSON.stringify(baseline)}`,
        ).toBe(200);
        expect(baseline.ready, "baseline ready").not.toBe(false);

        const crashRequest = await page.evaluate(async () => {
          const plugin = window.Capacitor?.Plugins?.Agent;
          if (!plugin?.debugCrashAndRestart) {
            throw new Error(
              "Agent.debugCrashAndRestart is not available on this Android debug build",
            );
          }
          return plugin.debugCrashAndRestart();
        });
        expect(crashRequest).toMatchObject({ ok: true, state: "restarting" });

        let recovered: HealthSnapshot = baseline;
        const startedAt = Date.now();
        await expect
          .poll(
            async () => {
              recovered = await page.evaluate(requestAgentHealth);
              healthSamples.push({
                phase: "recovery-poll",
                observedAt: new Date().toISOString(),
                health: recovered,
              });
              return recovered.status === 200 && recovered.ready !== false;
            },
            {
              timeout: 180_000,
              intervals: [1000, 2000, 5000],
              message:
                "on-device local agent did not recover after debug crash",
            },
          )
          .toBe(true);

        healthSamples.push({
          phase: "recovered",
          observedAt: new Date().toISOString(),
          health: recovered,
        });

        const resultPath = path.join(ARTIFACT_DIR, "agent-restart-result.json");
        fs.writeFileSync(
          resultPath,
          `${JSON.stringify(
            {
              platform: "android",
              serial,
              recoveryLatencyMs: Date.now() - startedAt,
              healthSamples,
            },
            null,
            2,
          )}\n`,
        );
        await testInfo.attach("agent restart result", {
          path: resultPath,
          contentType: "application/json",
        });

        const screenshotPath = captureAndroidScreenshot({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "android-agent-restart.png",
        });
        await testInfo.attach("agent restart screen", {
          path: screenshotPath,
          contentType: "image/png",
        });
      } finally {
        const consolePath = path.join(ARTIFACT_DIR, "webview-console.log");
        fs.writeFileSync(
          consolePath,
          `${consoleLines.join("\n")}\n${pageErrors
            .map((error) => `[pageerror] ${error}`)
            .join("\n")}\n`,
        );
        await testInfo.attach("WebView console", {
          path: consolePath,
          contentType: "text/plain",
        });

        const logcatPath = captureAndroidLogcat({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "logcat.txt",
          lines: 1000,
        });
        await testInfo.attach("Android logcat", {
          path: logcatPath,
          contentType: "text/plain",
        });

        const videoPath = await recording.stop();
        if (videoPath) {
          await testInfo.attach("agent restart walkthrough video", {
            path: videoPath,
            contentType: "video/mp4",
          });
        }
      }
    });
  });
