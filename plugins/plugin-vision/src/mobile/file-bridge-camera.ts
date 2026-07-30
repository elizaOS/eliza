/**
 * File-drop `MobileCameraSource` for the Android on-device agent.
 *
 * The agent runs in a Bun process with no `Capacitor.Plugins`, so it cannot
 * call the WebView's `ElizaCamera` directly. This source bridges over the one
 * filesystem both processes share (the agent's `AGENT_ROOT`, which is the app's
 * `files/agent` dir and maps to Capacitor `Directory.Data` + `agent` in the
 * WebView): the agent drops a capture request, the WebView (running
 * `startCameraBridgeResponder`) captures via `ElizaCamera` and drops the JPEG
 * back, and the agent reads it. A filesystem watcher wakes the pending capture
 * when the responder writes its ack; service shutdown cancels the wait. This
 * avoids both a polling tax and an arbitrary capture timeout.
 */

import { type FSWatcher, promises as fs, watch } from "node:fs";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import type { CameraInfo } from "../types";
import type { MobileCameraSource } from "./capacitor-camera";

const REQUEST_FILE = "capture.req";
const ACK_FILE = "capture.ack";
const ERROR_FILE = "capture.err";
const FRAME_FILE = "capture.jpg";

interface BridgeErrorAck {
  id: string;
  code: string;
  message: string;
}

export class CameraBridgeCaptureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CameraBridgeCaptureError";
  }
}

export function isTerminalCameraBridgeError(error: unknown): boolean {
  if (!(error instanceof CameraBridgeCaptureError)) return false;
  return (
    error.code === "camera_plugin_unavailable" ||
    error.code === "permission_denied" ||
    /permission denied/i.test(error.message)
  );
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

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      // error-policy:J4 A missing sidecar is the designed in-flight state.
      return null;
    }
    throw error;
  }
}

export class FileBridgeCameraSource implements MobileCameraSource {
  private seq = 0;
  private pendingCancel: ((error: Error) => void) | null = null;

  async listCameras(): Promise<CameraInfo[]> {
    // The WebView bridge opens the back camera; expose a single stable entry so
    // VisionService.findCamera() connects a device and routes capture here.
    return [{ id: "back", name: "Back Camera (bridge)", connected: true }];
  }

  async open(): Promise<void> {
    await fs.mkdir(bridgeDir(), { recursive: true });
  }

  async close(): Promise<void> {
    this.pendingCancel?.(
      new CameraBridgeCaptureError(
        "capture_cancelled",
        "Camera bridge capture cancelled because the source closed",
      ),
    );
  }

  async captureJpeg(): Promise<Buffer> {
    if (this.pendingCancel) {
      throw new CameraBridgeCaptureError(
        "capture_in_progress",
        "Camera bridge supports one in-flight capture",
      );
    }
    const dir = bridgeDir();
    await fs.mkdir(dir, { recursive: true });
    const id = `${Date.now()}-${++this.seq}`;
    // Clear any stale ack so we only accept a response to THIS request.
    await Promise.all([
      fs.rm(join(dir, ACK_FILE), { force: true }),
      fs.rm(join(dir, ERROR_FILE), { force: true }),
    ]);
    const response = this.waitForResponse(dir, id);
    try {
      await fs.writeFile(join(dir, REQUEST_FILE), id, "utf8");
      logger.info(`[FileBridgeCameraSource] capture requested (id=${id})`);
      return await response;
    } catch (error) {
      this.cancelPending(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private waitForResponse(dir: string, id: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let watcher: FSWatcher | null = null;
      let checking = false;
      let checkQueued = false;
      let settled = false;

      const finish = (error: Error | null, frame?: Buffer) => {
        if (settled) return;
        settled = true;
        watcher?.close();
        this.pendingCancel = null;
        if (error) reject(error);
        else if (frame) resolve(frame);
        else reject(new Error("Camera bridge completed without a frame"));
      };

      const check = async () => {
        if (settled) return;
        if (checking) {
          checkQueued = true;
          return;
        }
        checking = true;
        try {
          const [ack, errorRaw] = await Promise.all([
            readOptionalUtf8(join(dir, ACK_FILE)),
            readOptionalUtf8(join(dir, ERROR_FILE)),
          ]);
          logger.debug(
            `[FileBridgeCameraSource] bridge event (id=${id}, ack=${ack?.trim() ?? "none"}, error=${errorRaw ? "yes" : "no"})`,
          );
          if (ack?.trim() === id) {
            const frame = await fs.readFile(join(dir, FRAME_FILE));
            logger.info(
              `[FileBridgeCameraSource] frame received (id=${id}, ${frame.length} bytes)`,
            );
            finish(null, frame);
            return;
          }
          const errorAck = errorRaw ? parseBridgeError(errorRaw) : null;
          if (errorAck?.id === id) {
            finish(
              new CameraBridgeCaptureError(
                errorAck.code,
                `Camera bridge failed (${errorAck.code}) for request ${id}: ${errorAck.message}`,
              ),
            );
          }
        } finally {
          checking = false;
          if (checkQueued && !settled) {
            checkQueued = false;
            void check().catch((error) => {
              finish(error instanceof Error ? error : new Error(String(error)));
            });
          }
        }
      };

      this.pendingCancel = (error) => finish(error);
      try {
        watcher = watch(dir, (_eventType, filename) => {
          logger.debug(
            `[FileBridgeCameraSource] filesystem event (id=${id}, file=${String(filename)})`,
          );
          void check().catch((error) => {
            finish(error instanceof Error ? error : new Error(String(error)));
          });
        });
        watcher.on("error", (error) => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      void check().catch((error) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private cancelPending(error: Error): void {
    this.pendingCancel?.(error);
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
