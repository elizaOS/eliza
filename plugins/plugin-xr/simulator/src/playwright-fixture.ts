/**
 * Playwright fixture and page wrapper for XR emulator testing.
 *
 * Usage:
 *   import { test, expect } from './fixtures.ts';
 *
 *   test('full roundtrip', async ({ xrPage, mockAgent }) => {
 *     await xrPage.goto('/');
 *     await mockAgent.waitForConnection();
 *     await xrPage.injectCameraFrame('./fixtures/desk.jpg');
 *     const frame = await mockAgent.waitForCameraFrame();
 *     expect(frame.payload.length).toBeGreaterThan(100);
 *   });
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, type Page } from "@playwright/test";
import { MockAgentServer } from "./mock-agent.ts";
import type { EmulatorStats, XRPose } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMULATOR_DIST = resolve(__dirname, "../dist/emulator.js");

// ── XREmulatorPage ────────────────────────────────────────────────────────

export class XREmulatorPage {
  constructor(readonly page: Page) {}

  /** Inject the emulator script before the page loads. Call before page.goto(). */
  async inject(): Promise<void> {
    if (!existsSync(EMULATOR_DIST)) {
      throw new Error(
        `Emulator bundle not found at ${EMULATOR_DIST}. Run: cd eliza/plugins/plugin-xr/simulator && bun run build`,
      );
    }
    await this.page.addInitScript({ path: EMULATOR_DIST });
  }

  /** Navigate and wait for the emulator to be ready. */
  async goto(url: string): Promise<void> {
    await this.page.goto(url);
    // Wait for emulator to install (logs a console message)
    await this.page.waitForFunction(
      () => typeof window.__XREmulator !== "undefined",
      {
        timeout: 5000,
      },
    );
  }

  /** Set the emulated headset pose. */
  async setPose(pose: Partial<XRPose>): Promise<void> {
    await this.page.evaluate((p) => window.__XREmulator.setPose(p), pose);
  }

  /** Inject a camera frame from a local image file (JPEG or PNG). */
  async injectCameraFrame(imagePath: string): Promise<void> {
    const abs = resolve(imagePath);
    const data = readFileSync(abs);
    const mime = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
    const dataUrl = `data:${mime};base64,${data.toString("base64")}`;
    await this.page.evaluate(
      (url) => window.__XREmulator.injectCameraFrame(url),
      dataUrl,
    );
  }

  /** Inject a camera frame from an inline data URL. */
  async injectCameraDataUrl(dataUrl: string): Promise<void> {
    await this.page.evaluate(
      (url) => window.__XREmulator.injectCameraFrame(url),
      dataUrl,
    );
  }

  /** Send a synthetic audio chunk directly to the agent WebSocket. */
  async sendAudioChunk(
    base64: string,
    sampleRate = 48000,
    encoding = "webm-opus",
  ): Promise<void> {
    await this.page.evaluate(
      ({ b64, sr, enc }) => {
        if (!window.__xrTestHooks)
          throw new Error("__xrTestHooks not available — is VITE_TEST=true?");
        window.__xrTestHooks.sendAudioChunk(b64, sr, enc);
      },
      { b64: base64, sr: sampleRate, enc: encoding },
    );
  }

  /** Get emulator stats. */
  async getStats(): Promise<EmulatorStats> {
    return this.page.evaluate(() => window.__XREmulator.getStats());
  }

  /** Get WebSocket readyState from test hooks. */
  async getSocketState(): Promise<string> {
    return this.page.evaluate(() => {
      if (!window.__xrTestHooks) return "UNAVAILABLE";
      return window.__xrTestHooks.getSocketState();
    });
  }

  /** Wait for the page's status text to match a pattern. */
  async waitForStatus(pattern: string | RegExp, timeout = 8000): Promise<void> {
    await this.page
      .locator("#status-text")
      .filter({ hasText: pattern })
      .waitFor({
        state: "visible",
        timeout,
      });
  }

  /** Wait for agent response text to appear. */
  async waitForAgentText(timeout = 10000): Promise<string> {
    const el = this.page.locator("#agent-response");
    await el.waitFor({ state: "visible", timeout });
    await el.filter({ hasNotText: "" }).waitFor({ timeout });
    return el.innerText();
  }

  /** Wait for transcript text to appear. */
  async waitForTranscript(timeout = 10000): Promise<string> {
    const el = this.page.locator("#transcript");
    await el.waitFor({ state: "visible", timeout });
    await el.filter({ hasNotText: "" }).waitFor({ timeout });
    return el.innerText();
  }

  /** Force-disconnect the WebSocket (tests reconnect logic). */
  async simulateDisconnect(): Promise<void> {
    await this.page.evaluate(() => window.__XREmulator.simulateDisconnect());
  }
}

// ── Playwright fixture extensions ─────────────────────────────────────────

interface XRFixtures {
  mockAgent: MockAgentServer;
  xrPage: XREmulatorPage;
}

export const test = base.extend<XRFixtures>({
  mockAgent: async (_fixtures, use, testInfo) => {
    // Use a unique port per worker to allow parallel test runs
    const port = 31338 + testInfo.workerIndex;
    const server = new MockAgentServer({ port });
    await server.start();
    await use(server);
    await server.stop();
  },

  xrPage: async ({ page }, use) => {
    const xrp = new XREmulatorPage(page);
    await xrp.inject();
    await use(xrp);
  },
});

export { expect } from "@playwright/test";

// ── Node-side exports ─────────────────────────────────────────────────────

export { MockAgentServer } from "./mock-agent.ts";
export type { EmulatorStats, XRPose } from "./types.ts";
