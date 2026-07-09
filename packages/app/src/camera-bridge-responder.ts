/**
 * WebView half of the on-device-agent camera bridge.
 *
 * The Android agent (a Bun process) cannot reach the WebView's `ElizaCamera`
 * plugin, so `plugin-vision`'s `FileBridgeCameraSource` drops a capture request
 * in the agent's `vision-bridge` dir. This responder — running in the WebView,
 * which DOES own the Capacitor camera — polls for that request, captures a
 * photo through `ElizaCamera` (brief rear-camera preview → single frame), and
 * writes the JPEG + an ack back for the agent to read.
 *
 * The shared dir is the app's `files/agent/vision-bridge`, reached here through
 * Capacitor `Directory.Data` + `agent/vision-bridge` (the agent's `AGENT_ROOT`
 * is `files/agent`). Single in-flight capture; request/ack correlate by id.
 */

import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";

const DIR = "agent/vision-bridge";
const REQUEST_PATH = `${DIR}/capture.req`;
const ACK_PATH = `${DIR}/capture.ack`;
const ERROR_PATH = `${DIR}/capture.err`;
const FRAME_PATH = `${DIR}/capture.jpg`;
const POLL_INTERVAL_MS = 400;

interface ElizaCameraLike {
  requestPermissions?: () => Promise<{ camera?: string } | unknown>;
  startPreview: (opts: {
    element: HTMLElement;
    direction?: string;
    resolution?: { width: number; height: number };
  }) => Promise<unknown>;
  capturePhoto: (opts?: {
    quality?: number;
    format?: string;
  }) => Promise<{ base64: string }>;
  stopPreview: () => Promise<unknown>;
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getCamera(): ElizaCameraLike | null {
  const plugins = (
    globalThis as unknown as {
      Capacitor?: { Plugins?: Record<string, unknown> };
    }
  ).Capacitor?.Plugins;
  const cam = plugins?.ElizaCamera as ElizaCameraLike | undefined;
  return cam && typeof cam.capturePhoto === "function" ? cam : null;
}

/** Off-screen, measurable host for the CameraX preview (display:none refuses to
 * start a preview surface, so keep it attached and 1×1 rather than hidden). */
function makePreviewHost(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-eliza-camera-bridge", "");
  el.style.cssText =
    "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;";
  document.body.appendChild(el);
  return el;
}

async function readText(path: string): Promise<string | null> {
  try {
    const res = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return typeof res.data === "string" ? res.data.trim() : null;
  } catch {
    // error-policy:J4 absent request/ack files are the designed idle state.
    // Absent request/ack is the normal idle state — not an error.
    return null;
  }
}

async function ensureBridgeDir(): Promise<void> {
  await Filesystem.mkdir({
    path: DIR,
    directory: Directory.Data,
    recursive: true,
  }).catch(() => {
    // error-policy:J6 mkdir races with the agent/WebView bridge are harmless.
  });
}

async function writeBridgeError(
  reqId: string,
  code: string,
  error: unknown,
): Promise<void> {
  await ensureBridgeDir();
  await Filesystem.writeFile({
    path: ERROR_PATH,
    directory: Directory.Data,
    data: JSON.stringify({
      id: reqId,
      code,
      message: messageForError(error),
    }),
    encoding: Encoding.UTF8,
  });
}

async function captureOnce(camera: ElizaCameraLike): Promise<string> {
  const host = makePreviewHost();
  try {
    await camera.requestPermissions?.().catch(() => {
      // error-policy:J4 native camera plugins may request lazily at preview.
    });
    await camera.startPreview({
      element: host,
      direction: "rear",
      resolution: { width: 1280, height: 720 },
    });
    // A frame needs the sensor warmed; one short beat avoids a black frame.
    await new Promise((r) => setTimeout(r, 350));
    const photo = await camera.capturePhoto({ quality: 85, format: "jpeg" });
    return photo.base64;
  } finally {
    await camera.stopPreview().catch(() => {
      // error-policy:J6 preview teardown is best-effort after capture failure.
    });
    host.remove();
  }
}

/**
 * Start the responder loop. Idempotent per WebView; returns a stop function.
 * Safe to call on every mobile boot — off Android (no ElizaCamera) it idles.
 */
export function startCameraBridgeResponder(): () => void {
  let stopped = false;
  let lastHandled: string | null = null;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    const reqId = await readText(REQUEST_PATH);
    if (!reqId || reqId === lastHandled) return;
    const camera = getCamera();
    if (!camera) {
      await writeBridgeError(
        reqId,
        "camera_plugin_unavailable",
        "ElizaCamera plugin unavailable",
      );
      lastHandled = reqId;
      return;
    }
    busy = true;
    lastHandled = reqId;
    try {
      await ensureBridgeDir();
      const base64 = await captureOnce(camera);
      await Filesystem.writeFile({
        path: FRAME_PATH,
        directory: Directory.Data,
        data: base64, // base64 with no encoding → binary JPEG on disk
      });
      await Filesystem.writeFile({
        path: ACK_PATH,
        directory: Directory.Data,
        data: reqId,
        encoding: Encoding.UTF8,
      });
      // eslint-disable-next-line no-console
      console.info(`[camera-bridge] served capture ${reqId}`);
    } catch (err) {
      await writeBridgeError(reqId, "capture_failed", err).catch((writeErr) => {
        // error-policy:J7 bridge diagnostics must not kill the responder loop.
        // eslint-disable-next-line no-console
        console.warn(
          `[camera-bridge] failed to write error ack for ${reqId}:`,
          messageForError(writeErr),
        );
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[camera-bridge] capture ${reqId} failed:`,
        messageForError(err),
      );
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((err) => {
      // error-policy:J7 bridge diagnostics must not kill the responder loop.
      // eslint-disable-next-line no-console
      console.warn(
        "[camera-bridge] responder tick failed:",
        messageForError(err),
      );
    });
  }, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
