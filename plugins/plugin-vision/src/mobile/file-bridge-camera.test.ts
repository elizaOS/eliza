/**
 * Exercises the real filesystem camera bridge wakeup, error propagation, and
 * cancellation without replacing the filesystem watcher with a mock.
 */
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CameraBridgeCaptureError,
  FileBridgeCameraSource,
  isTerminalCameraBridgeError,
} from "./file-bridge-camera";

const originalAgentRoot = process.env.AGENT_ROOT;
let testRoot: string | null = null;

afterEach(async () => {
  if (originalAgentRoot === undefined) delete process.env.AGENT_ROOT;
  else process.env.AGENT_ROOT = originalAgentRoot;
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
  testRoot = null;
});

async function setup() {
  testRoot = await mkdtemp(join(tmpdir(), "eliza-camera-bridge-"));
  process.env.AGENT_ROOT = testRoot;
  const source = new FileBridgeCameraSource();
  await source.open();
  return {
    source,
    dir: join(testRoot, "vision-bridge"),
  };
}

async function waitForRequest(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const readIfPresent = async (): Promise<string | null> => {
      try {
        return await readFile(join(dir, "capture.req"), "utf8");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }
        throw error;
      }
    };
    const watcher = watch(dir, () => {
      void readIfPresent()
        .then((id) => {
          if (id === null) return;
          watcher.close();
          resolve(id);
        })
        .catch(reject);
    });
    watcher.on("error", reject);
    void readIfPresent()
      .then((id) => {
        if (id === null) return;
        watcher.close();
        resolve(id);
      })
      .catch(reject);
  });
}

describe("FileBridgeCameraSource", () => {
  it("resolves when the responder writes the matching frame and ack", async () => {
    const { source, dir } = await setup();
    const capture = source.captureJpeg();
    const id = await waitForRequest(dir);
    await writeFile(join(dir, "capture.jpg"), Buffer.from("jpeg"));
    await writeFile(join(dir, "capture.ack"), id);
    await expect(capture).resolves.toEqual(Buffer.from("jpeg"));
  });

  it("preserves structured terminal permission errors", async () => {
    const { source, dir } = await setup();
    const capture = source.captureJpeg();
    const id = await waitForRequest(dir);
    await writeFile(
      join(dir, "capture.err"),
      JSON.stringify({
        id,
        code: "capture_failed",
        message: "Camera permission denied",
      }),
    );
    const error = await capture.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CameraBridgeCaptureError);
    expect(isTerminalCameraBridgeError(error)).toBe(true);
  });

  it("cancels an in-flight capture when the source closes", async () => {
    const { source, dir } = await setup();
    const capture = source.captureJpeg();
    await waitForRequest(dir);
    await source.close();
    await expect(capture).rejects.toMatchObject({
      code: "capture_cancelled",
    });
  });

  it("rejects a second capture instead of overwriting the active request", async () => {
    const { source, dir } = await setup();
    const capture = source.captureJpeg();
    await waitForRequest(dir);

    await expect(source.captureJpeg()).rejects.toMatchObject({
      code: "capture_in_progress",
    });

    await source.close();
    await expect(capture).rejects.toMatchObject({
      code: "capture_cancelled",
    });
  });
});
