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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, type Page } from "@playwright/test";
import { MockAgentServer } from "./mock-agent.ts";
import type {
  DeviceRay,
  EmulatorStats,
  Handedness,
  InputEventRecord,
  InputSourceSnapshot,
  TelemetrySnapshot,
  Vec3,
  XRPose,
  XRSessionMode,
} from "./types.ts";

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

  // ── Immersive session + input (IWER-backed) ──────────────────────────────

  /** Start an immersive WebXR session. */
  async startSession(mode: XRSessionMode = "immersive-vr"): Promise<boolean> {
    return this.page.evaluate((m) => window.__XREmulator.startSession(m), mode);
  }

  /** End the active session. */
  async endSession(): Promise<void> {
    await this.page.evaluate(() => window.__XREmulator.endSession());
  }

  /** Set a controller's world pose. */
  async setControllerPose(
    handedness: Handedness,
    pose: Partial<XRPose>,
  ): Promise<void> {
    await this.page.evaluate(
      ({ h, p }) => window.__XREmulator.setControllerPose(h, p),
      { h: handedness, p: pose },
    );
  }

  /** Set a hand's named pose ("default" / "pinch" / "point"); activates the hand. */
  async setHandPose(handedness: Handedness, poseId: string): Promise<void> {
    await this.page.evaluate(
      ({ h, p }) => window.__XREmulator.setHandPose(h, p),
      { h: handedness, p: poseId },
    );
  }

  /** Aim a controller's ray at an element's screen center. */
  async aimControllerAt(
    handedness: Handedness,
    selector: string,
  ): Promise<boolean> {
    return this.page.evaluate(
      ({ h, s }) => window.__XREmulator.aimControllerAt(h, s),
      { h: handedness, s: selector },
    );
  }

  /** Aim a hand-tracking input's target ray at an element. */
  async aimHandAt(handedness: Handedness, selector: string): Promise<boolean> {
    return this.page.evaluate(
      ({ h, s }) => window.__XREmulator.aimHandAt(h, s),
      { h: handedness, s: selector },
    );
  }

  /** Aim the headset's gaze ray at an element. */
  async aimHeadAt(selector: string): Promise<boolean> {
    return this.page.evaluate(
      (s) => window.__XREmulator.aimHeadAt(s),
      selector,
    );
  }

  /** Fire select (trigger) on a controller. */
  async pressSelect(handedness: Handedness): Promise<void> {
    await this.page.evaluate(
      (h) => window.__XREmulator.pressSelect(h),
      handedness,
    );
  }

  /** Fire squeeze (grip) on a controller. */
  async pressSqueeze(handedness: Handedness): Promise<void> {
    await this.page.evaluate(
      (h) => window.__XREmulator.pressSqueeze(h),
      handedness,
    );
  }

  /** Pinch-select with a hand-tracking input (real hand select events). */
  async pressHandSelect(handedness: Handedness): Promise<void> {
    await this.page.evaluate(
      (h) => window.__XREmulator.pressHandSelect(h),
      handedness,
    );
  }

  /** Snapshot poses + element rects + aiming rays + computed hits. */
  async getElementTelemetry(selector?: string): Promise<TelemetrySnapshot> {
    return this.page.evaluate(
      (s) => window.__XREmulator.getElementTelemetry(s),
      selector,
    );
  }

  async getSelectLog(): Promise<InputEventRecord[]> {
    return this.page.evaluate(() => window.__XREmulator.getSelectLog());
  }

  async getSqueezeLog(): Promise<InputEventRecord[]> {
    return this.page.evaluate(() => window.__XREmulator.getSqueezeLog());
  }

  /** The active session's live XRInputSource list. */
  async getInputSources(): Promise<InputSourceSnapshot[]> {
    return this.page.evaluate(() => window.__XREmulator.getInputSources());
  }

  // ── 3D scene (XRSpatialScene) read-back + manipulation ─────────────────────

  /** True once a mounted XRSpatialScene is driving 3D hit-tests. */
  async hasScene(): Promise<boolean> {
    return this.page.evaluate(() => window.__XREmulator.hasScene());
  }

  /** The current emulated headset world pose. */
  async getHeadPose(): Promise<XRPose> {
    return this.page.evaluate(() => window.__XREmulator.getHeadPose());
  }

  /** A connected controller's world pose, or null. */
  async getControllerPose(handedness: Handedness): Promise<XRPose | null> {
    return this.page.evaluate(
      (h) => window.__XREmulator.getControllerPose(h),
      handedness,
    );
  }

  /** A controller's world-space aiming ray, or null. */
  async getControllerRay(handedness: Handedness): Promise<DeviceRay | null> {
    return this.page.evaluate(
      (h) => window.__XREmulator.getControllerRay(h),
      handedness,
    );
  }

  /** Drag the panel a controller is aimed at by a world delta; returns new position. */
  async dragController(
    handedness: Handedness,
    delta: Vec3,
  ): Promise<Vec3 | null> {
    return this.page.evaluate(
      ({ h, d }) => window.__XREmulator.dragController(h, d),
      { h: handedness, d: delta },
    );
  }

  /** Pinch-grab the panel a hand is aimed at and drag it by a world delta; returns new position. */
  async dragHand(handedness: Handedness, delta: Vec3): Promise<Vec3 | null> {
    return this.page.evaluate(
      ({ h, d }) => window.__XREmulator.dragHand(h, d),
      { h: handedness, d: delta },
    );
  }

  // ── Capture ──────────────────────────────────────────────────────────────

  /** Write a PNG screenshot of the page into the artifact dir. */
  async captureScreenshot(name: string): Promise<string> {
    const dir = artifactDir();
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${name}.png`);
    await this.page.screenshot({ path: out });
    return out;
  }

  /** Write the per-frame pose/ray/hit telemetry log as JSON into the artifact dir. */
  async captureFrameLog(name: string): Promise<string> {
    const dir = artifactDir();
    mkdirSync(dir, { recursive: true });
    const log = await this.page.evaluate(() =>
      window.__XREmulator.getFrameLog(),
    );
    const out = join(dir, `${name}.frames.json`);
    writeFileSync(out, `${JSON.stringify(log, null, 2)}\n`);
    return out;
  }
}

/** Where capture artifacts land (override with XR_E2E_ARTIFACT_DIR). */
export function artifactDir(): string {
  if (process.env.XR_E2E_ARTIFACT_DIR) return process.env.XR_E2E_ARTIFACT_DIR;
  return resolve(__dirname, "..", "e2e-artifacts");
}

// ── Playwright fixture extensions ─────────────────────────────────────────

interface XRFixtures {
  mockAgent: MockAgentServer;
  xrPage: XREmulatorPage;
}

export const test = base.extend<XRFixtures>({
  mockAgent: async ({}, use, testInfo) => {
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
