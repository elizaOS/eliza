/**
 * File-drop `MobileCameraSource` for the Android on-device agent.
 *
 * The agent runs in a Bun process with no `Capacitor.Plugins`, so it cannot
 * call the WebView's `ElizaCamera` directly. This source bridges over the one
 * filesystem both processes share (the agent's `AGENT_ROOT`, which is the app's
 * `files/agent` dir and maps to Capacitor `Directory.Data` + `agent` in the
 * WebView): the agent drops a capture request, the WebView (running
 * `startCameraBridgeResponder`) captures via `ElizaCamera` and drops the JPEG
 * back, and the agent reads it. Deliberately simple — a single in-flight
 * capture at a time, request/ack by a monotonic id, bounded poll.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import type { CameraInfo } from "../types";
import type { MobileCameraSource } from "./capacitor-camera";

const REQUEST_FILE = "capture.req";
const ACK_FILE = "capture.ack";
const ERROR_FILE = "capture.err";
const FRAME_FILE = "capture.jpg";
const POLL_INTERVAL_MS = 200;
const CAPTURE_TIMEOUT_MS = 12_000;

interface BridgeErrorAck {
  id: string;
  code: string;
  message: string;
}

function bridgeDir(): string {
  const root =
    process.env.AGENT_ROOT || process.env.ELIZA_STATE_DIR || process.cwd();
  return join(root, "vision-bridge");
}

function parseBridgeError(raw: string): BridgeErrorAck | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BridgeErrorAck>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.code === "string" &&
      typeof parsed.message === "string"
    ) {
      return parsed as BridgeErrorAck;
    }
  } catch {
    // error-policy:J3 bridge error sidecar is WebView-written untrusted input.
  }
  return null;
}

export class FileBridgeCameraSource implements MobileCameraSource {
  private seq = 0;

  async listCameras(): Promise<CameraInfo[]> {
    // The WebView bridge opens the back camera; expose a single stable entry so
    // VisionService.findCamera() connects a device and routes capture here.
    return [{ id: "back", name: "Back Camera (bridge)", connected: true }];
  }

  async open(): Promise<void> {
    await fs.mkdir(bridgeDir(), { recursive: true });
  }

  async close(): Promise<void> {
    // The WebView owns the camera session; nothing to tear down agent-side.
  }

  async captureJpeg(): Promise<Buffer> {
    const dir = bridgeDir();
    await fs.mkdir(dir, { recursive: true });
    const id = `${Date.now()}-${++this.seq}`;
    // Clear any stale ack so we only accept a response to THIS request.
    await fs.rm(join(dir, ACK_FILE), { force: true }).catch(() => {
      // error-policy:J6 stale ack cleanup is best-effort before a new request.
    });
    await fs.rm(join(dir, ERROR_FILE), { force: true }).catch(() => {
      // error-policy:J6 stale error cleanup is best-effort before a new request.
    });
    await fs.writeFile(join(dir, REQUEST_FILE), id, "utf8");
    logger.info(`[FileBridgeCameraSource] capture requested (id=${id})`);

    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let ack: string | null = null;
      try {
        ack = (await fs.readFile(join(dir, ACK_FILE), "utf8")).trim();
      } catch {
        // error-policy:J4 missing ack is the designed in-flight bridge state.
        // ack not written yet — the WebView responder hasn't finished; keep
        // polling until the deadline, which throws a real timeout below.
      }
      if (ack === id) {
        const frame = await fs.readFile(join(dir, FRAME_FILE));
        logger.info(
          `[FileBridgeCameraSource] frame received (id=${id}, ${frame.length} bytes)`,
        );
        return frame;
      }
      try {
        const errorAck = parseBridgeError(
          await fs.readFile(join(dir, ERROR_FILE), "utf8"),
        );
        if (errorAck?.id === id) {
          throw new Error(
            `Camera bridge failed (${errorAck.code}) for request ${id}: ${errorAck.message}`,
          );
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.startsWith("Camera bridge failed")
        ) {
          throw err;
        }
        // error-policy:J4 missing or malformed error sidecar is not terminal
        // while the capture is still within its response deadline.
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(
      `Camera bridge timed out after ${CAPTURE_TIMEOUT_MS}ms (id=${id}); is the WebView camera responder running and permitted?`,
    );
  }

  capabilities(): {
    supportsContinuousFrames: boolean;
    supportsExposureLock: boolean;
    supportsTorch: boolean;
  } {
    return {
      supportsContinuousFrames: false,
      supportsExposureLock: false,
      supportsTorch: false,
    };
  }
}
