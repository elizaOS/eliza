import { rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  FRAME_FILE,
  getBrowserCaptureExecutablePath,
  isBrowserCaptureSupported,
  startBrowserCapture,
  stopBrowserCapture,
} from "@elizaos/plugin-browser";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { LifeOpsScreenContextSampler } from "../src/lifeops/screen-context.js";

const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const CHROME_SUPPORTED = isBrowserCaptureSupported();

console.info(
  `[lifeops-screen-live] live=${LIVE_TESTS_ENABLED} chrome=${CHROME_SUPPORTED} chromePath=${getBrowserCaptureExecutablePath()}`,
);

const missingSetupReasons = [
  !LIVE_TESTS_ENABLED ? "set ELIZA_LIVE_TEST=1" : null,
  !CHROME_SUPPORTED
    ? `install Google Chrome at ${getBrowserCaptureExecutablePath()}`
    : null,
].filter((entry): entry is string => Boolean(entry));

if (missingSetupReasons.length > 0) {
  console.info(
    `[lifeops-screen-live] skipped until setup is complete: ${missingSetupReasons.join(" | ")}`,
  );
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

describeIf(LIVE_TESTS_ENABLED && CHROME_SUPPORTED)(
  "Live: LifeOps screen context from browser capture",
  () => {
    let closeServer: (() => Promise<void>) | undefined;
    let tempRoot = "";
    let serverUrl = "";

    beforeAll(async () => {
      tempRoot = await fsMkdtemp(path.join(os.tmpdir(), "eliza-screen-live-"));
      await rm(FRAME_FILE, { force: true });

      const port = await getFreePort();
      const server = createServer((_, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html>
            <body style="margin:0;font-family:Arial,sans-serif;background:#fff;color:#111">
              <main style="padding:40px">
                <h1>LifeOps screen capture test</h1>
                <p>Inbox Calendar Meeting Terminal GitHub</p>
              </main>
            </body>
          </html>`);
      });

      await new Promise<void>((resolve) =>
        server.listen(port, "127.0.0.1", resolve),
      );
      serverUrl = `http://127.0.0.1:${port}`;
      closeServer = async () => {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(tempRoot, { recursive: true, force: true });
      };
    }, 30_000);

    afterAll(async () => {
      await stopBrowserCapture();
      await closeServer?.();
    });

    it("captures a real browser frame and samples it into screen context", async () => {
      await startBrowserCapture({
        url: `${serverUrl}/`,
        width: 960,
        height: 540,
        quality: 70,
      });

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const stats = await stat(FRAME_FILE).catch(() => null);
        if (stats && stats.size > 0) {
          break;
        }
        await sleep(250);
      }

      const sampler = new LifeOpsScreenContextSampler({
        framePath: FRAME_FILE,
        minSampleIntervalMs: 0,
      });
      let summary = await sampler.sample();
      const sampleDeadline = Date.now() + 10_000;
      while (
        Date.now() < sampleDeadline &&
        (summary.source !== "browser-capture" || !summary.available)
      ) {
        await sleep(250);
        summary = await sampler.sample();
      }

      expect(summary.source).toBe("browser-capture");
      expect(summary.available).toBe(true);
      expect(summary.width).toBeGreaterThan(0);
      expect(summary.height).toBeGreaterThan(0);
      expect(summary.byteLength).toBeGreaterThan(0);
      expect(summary.framePath).toBe(FRAME_FILE);
    }, 60_000);
  },
);

async function fsMkdtemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return await mkdtemp(prefix);
}
