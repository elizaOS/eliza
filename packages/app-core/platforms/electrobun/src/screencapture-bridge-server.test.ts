/**
 * Functional loopback tests for the Electrobun screen-capture bridge.
 *
 * The harness binds a real localhost HTTP server but uses a fake capture
 * manager, so it verifies auth, env handoff, and request normalization without
 * invoking OS screen-capture tools.
 */

import { describe, expect, it } from "vitest";
import {
  type ScreenCaptureBridgeManager,
  startScreenCaptureBridgeServer,
} from "./screencapture-bridge-server";

function testPort(): number {
  return 39_000 + Math.floor(Math.random() * 1000);
}

describe("startScreenCaptureBridgeServer", () => {
  it("publishes bridge env and forwards authenticated frame-capture controls", async () => {
    const starts: unknown[] = [];
    let active = false;
    const manager: ScreenCaptureBridgeManager = {
      async startFrameCapture(options) {
        starts.push(options);
        active = true;
        return { available: true };
      },
      async stopFrameCapture() {
        active = false;
        return { available: true };
      },
      async isFrameCaptureActive() {
        return { active };
      },
    };
    const env: NodeJS.ProcessEnv = {
      ELIZA_DESKTOP_SCREENCAPTURE_PORT: String(testPort()),
    };

    const stop = await startScreenCaptureBridgeServer({
      env,
      manager,
      token: "bridge-token",
    });
    try {
      expect(env.ELIZA_DESKTOP_SCREENCAPTURE_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+$/,
      );
      expect(env.ELIZA_DESKTOP_SCREENCAPTURE_TOKEN).toBe("bridge-token");

      const unauthorized = await fetch(
        `${env.ELIZA_DESKTOP_SCREENCAPTURE_URL}/health`,
      );
      expect(unauthorized.status).toBe(401);

      const started = await fetch(
        `${env.ELIZA_DESKTOP_SCREENCAPTURE_URL}/frame-capture/start`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer bridge-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            fps: 15,
            quality: 70,
            apiBase: "http://127.0.0.1:31337/ignored",
            endpoint: "/api/stream/frame",
            gameUrl: "http://127.0.0.1:5173/game",
          }),
        },
      );
      expect(started.status).toBe(200);
      expect(await started.json()).toEqual({ available: true });
      expect(starts).toEqual([
        {
          fps: 15,
          quality: 70,
          apiBase: "http://127.0.0.1:31337",
          endpoint: "/api/stream/frame",
          gameUrl: "http://127.0.0.1:5173/game",
        },
      ]);

      const health = await fetch(
        `${env.ELIZA_DESKTOP_SCREENCAPTURE_URL}/health`,
        { headers: { Authorization: "Bearer bridge-token" } },
      );
      expect(await health.json()).toEqual({ ok: true, active: true });

      const stopped = await fetch(
        `${env.ELIZA_DESKTOP_SCREENCAPTURE_URL}/frame-capture/stop`,
        { method: "POST", headers: { Authorization: "Bearer bridge-token" } },
      );
      expect(await stopped.json()).toEqual({ available: true });
      expect(active).toBe(false);
    } finally {
      stop();
    }
  });

  it("rejects malformed frame endpoint paths before calling the manager", async () => {
    const starts: unknown[] = [];
    const manager: ScreenCaptureBridgeManager = {
      async startFrameCapture(options) {
        starts.push(options);
        return { available: true };
      },
      async stopFrameCapture() {
        return { available: true };
      },
      async isFrameCaptureActive() {
        return { active: false };
      },
    };
    const env: NodeJS.ProcessEnv = {
      ELIZA_DESKTOP_SCREENCAPTURE_PORT: String(testPort()),
    };

    const stop = await startScreenCaptureBridgeServer({
      env,
      manager,
      token: "bridge-token",
    });
    try {
      const response = await fetch(
        `${env.ELIZA_DESKTOP_SCREENCAPTURE_URL}/frame-capture/start`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer bridge-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            apiBase: "https://example.com",
            endpoint: "https://example.com/frame",
          }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "apiBase must be an http loopback URL",
      });
      expect(starts).toEqual([]);
    } finally {
      stop();
    }
  });
});
