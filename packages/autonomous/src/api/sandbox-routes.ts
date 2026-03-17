/** Sandbox capability API routes: status, exec, browser, screen, audio, computer use. */

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteSigningService } from "../services/remote-signing-service";
import type { SandboxManager } from "../services/sandbox-manager";
import type { SigningRequest } from "../services/signing-policy";
import {
  readJsonBody as parseJsonBody,
  readRequestBody,
  sendJson as sendJsonResponse,
} from "./http-helpers";

interface SandboxRouteState {
  sandboxManager: SandboxManager | null;
  signingService?: RemoteSigningService | null;
}

const MAX_COMPUTER_INPUT_LENGTH = 4096;
const MAX_KEYPRESS_LENGTH = 128;
const SAFE_KEYPRESS_PATTERN = /^[A-Za-z0-9+_.,: -]+$/;
const ALLOWED_AUDIO_FORMATS = new Set(["wav", "mp3", "ogg", "flac", "m4a"]);
const MIN_AUDIO_RECORD_DURATION_MS = 250;
const MAX_AUDIO_RECORD_DURATION_MS = 30_000;

// ── Route handler ────────────────────────────────────────────────────────────

/** Returns `true` if handled, `false` to fall through. */
export async function handleSandboxRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  state: SandboxRouteState,
): Promise<boolean> {
  if (!pathname.startsWith("/api/sandbox")) {
    return false;
  }

  const mgr = state.sandboxManager;

  // Platform info doesn't require a running manager
  if (method === "GET" && pathname === "/api/sandbox/platform") {
    sendJson(res, 200, getPlatformInfo());
    return true;
  }

  // ── POST /api/sandbox/docker/start ────────────────────────────────
  // Attempt to start Docker Desktop (works on macOS/Windows Electron)
  if (method === "POST" && pathname === "/api/sandbox/docker/start") {
    try {
      const result = attemptDockerStart();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        success: false,
        error: `Failed to start Docker: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  if (!mgr) {
    sendJson(res, 503, {
      error: "Sandbox manager not initialized",
    });
    return true;
  }

  // ── GET /api/sandbox/status ─────────────────────────────────────────
  if (method === "GET" && pathname === "/api/sandbox/status") {
    sendJson(res, 200, mgr.getStatus());
    return true;
  }

  // ── GET /api/sandbox/events ─────────────────────────────────────────
  if (method === "GET" && pathname === "/api/sandbox/events") {
    const events = mgr.getEventLog();
    sendJson(res, 200, { events: events.slice(-100) });
    return true;
  }

  // ── POST /api/sandbox/start ─────────────────────────────────────────
  if (method === "POST" && pathname === "/api/sandbox/start") {
    try {
      await mgr.start();
      sendJson(res, 200, mgr.getStatus());
    } catch (err) {
      sendJson(res, 500, {
        error: `Failed to start sandbox: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ── POST /api/sandbox/stop ──────────────────────────────────────────
  if (method === "POST" && pathname === "/api/sandbox/stop") {
    try {
      await mgr.stop();
      sendJson(res, 200, mgr.getStatus());
    } catch (err) {
      sendJson(res, 500, {
        error: `Failed to stop sandbox: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ── POST /api/sandbox/recover ───────────────────────────────────────
  if (method === "POST" && pathname === "/api/sandbox/recover") {
    try {
      await mgr.recover();
      sendJson(res, 200, mgr.getStatus());
    } catch (err) {
      sendJson(res, 500, {
        error: `Recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ── POST /api/sandbox/exec ──────────────────────────────────────────
  if (method === "POST" && pathname === "/api/sandbox/exec") {
    const parsed = await readJsonBody<{
      command?: string;
      workdir?: string;
      timeoutMs?: number;
    }>(req, res);
    if (!parsed) return true;

    if (!parsed.command || typeof parsed.command !== "string") {
      sendJson(res, 400, { error: "Missing 'command' field" });
      return true;
    }

    const result = await mgr.exec({
      command: parsed.command,
      workdir: parsed.workdir,
      timeoutMs: parsed.timeoutMs,
    });

    sendJson(res, result.exitCode === 0 ? 200 : 422, result);
    return true;
  }

  // ── GET /api/sandbox/browser ────────────────────────────────────────
  if (method === "GET" && pathname === "/api/sandbox/browser") {
    sendJson(res, 200, {
      cdpEndpoint: mgr.getBrowserCdpEndpoint(),
      wsEndpoint: mgr.getBrowserWsEndpoint(),
      noVncEndpoint: mgr.getBrowserNoVncEndpoint(),
    });
    return true;
  }

  // ── Capability bridges ──────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/sandbox/screen/screenshot") {
    try {
      const screenshot = captureScreenshot();
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": screenshot.length,
      });
      res.end(screenshot);
    } catch (err) {
      sendJson(res, 500, {
        error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ── POST /api/sandbox/screen/screenshot ─────────────────────────────
  // Returns base64-encoded screenshot for easy consumption by agents
  if (method === "POST" && pathname === "/api/sandbox/screen/screenshot") {
    const rawBody = await readBody(req);
    if (!rawBody || !rawBody.trim()) {
      sendJson(res, 200, {
        format: "png",
        encoding: "base64",
        width: null,
        height: null,
        data: captureScreenshot().toString("base64"),
      });
      return true;
    }

    let regionInput: unknown;
    try {
      regionInput = JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    const region = resolveScreenshotRegion(regionInput);
    if (region.error) {
      sendJson(res, 400, { error: region.error });
      return true;
    }

    try {
      const screenshot = captureScreenshot(region.region);
      const base64 = screenshot.toString("base64");
      sendJson(res, 200, {
        format: "png",
        encoding: "base64",
        width: null, // platform-dependent
        height: null,
        data: base64,
      });
    } catch (err) {
      sendJson(res, 500, {
        error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ── GET /api/sandbox/screen/windows ─────────────────────────────────
  if (method === "GET" && pathname === "/api/sandbox/screen/windows") {
    try {
      const windows = listWindows();
      sendJson(res, 200, { windows });
    } catch (err) {
      sendJson(res, 200, { windows: [], error: String(err) });
    }
    return true;
  }

  // ── POST /api/sandbox/audio/record ──────────────────────────────────
  if (method === "POST" && pathname === "/api/sandbox/audio/record") {
    const body = await readBody(req);
    let durationMs = 5000;
    if (body) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, {
          error: "Invalid JSON in request body",
        });
        return true;
      }

      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        sendJson(res, 400, { error: "Request body must be a JSON object" });
        return true;
      }

      const bodyValues = parsed as Record<string, unknown>;

      if (Object.hasOwn(bodyValues, "durationMs")) {
        const durationValue = bodyValues.durationMs;
        if (typeof durationValue !== "number") {
          sendJson(res, 400, {
            error: "durationMs must be a finite number",
          });
          return true;
        }
        // Defense in depth: JSON.parse only produces finite numbers, but this guard
        // keeps behavior explicit against future parser/runtime changes.
        if (!Number.isFinite(durationValue)) {
          sendJson(res, 400, {
            error: "durationMs must be a finite number",
          });
          return true;
        }
        if (!Number.isInteger(durationValue)) {
          sendJson(res, 400, {
            error: "durationMs must be an integer number of milliseconds",
          });
          return true;
        }
        if (
          durationValue < MIN_AUDIO_RECORD_DURATION_MS ||
          durationValue > MAX_AUDIO_RECORD_DURATION_MS
        ) {
          sendJson(res, 400, {
            error: `durationMs must be between ${MIN_AUDIO_RECORD_DURATION_MS} and ${MAX_AUDIO_RECORD_DURATION_MS} milliseconds`,
          });
          return true;
        }
        durationMs = durationValue;
      }
    }
    try {
      const audio = await recordAudio(durationMs);
      sendJson(res, 200, {
        format: "wav",
        encoding: "base64",
        durationMs,
        data: audio.toString("base64"),
      });
    } catch (err) {
      sendJson(res, 500, {
        error: `Audio recording failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ── POST /api/sandbox/audio/play ────────────────────────────────────
  if (method === "POST" && pathname === "/api/sandbox/audio/play") {
    const parsed = await readJsonBody(req, res);
    if (!parsed) return true;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return true;
    }

    const payload = parsed as { data?: unknown; format?: unknown };
    if (typeof payload.data !== "string" || !payload.data.trim()) {
      sendJson(res, 400, { error: "Missing 'data' field (base64 audio)" });
      return true;
    }

    const formatResult = resolveAudioFormat(payload.format);
    if (formatResult.error) {
      sendJson(res, 400, { error: formatResult.error });
      return true;
    }

    try {
      await playAudio(Buffer.from(payload.data, "base64"), formatResult.format);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, {
        error: `Audio playback failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ── POST /api/sandbox/computer/click ────────────────────────────────
  if (method === "POST" && pathname === "/api/sandbox/computer/click") {
    const parsed = await readJsonBody(req, res);
    if (!parsed) return true;

    const clickPayload = resolveClickPayload(parsed);
    if (clickPayload.error) {
      sendJson(res, 400, { error: clickPayload.error });
      return true;
    }

    try {
      const { x, y, button } = clickPayload;
      performClick(x, y, button);
      sendJson(res, 200, { success: true, x, y, button });
    } catch (err) {
      sendJson(res, 500, {
        error: `Click failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ── POST /api/sandbox/computer/type ─────────────────────────────────
  if (method === "POST" && pathname === "/api/sandbox/computer/type") {
    const parsed = await readJsonBody(req, res);
    if (!parsed) return true;

    const typePayload = resolveTypePayload(parsed);
    if (typePayload.error) {
      sendJson(res, 400, { error: typePayload.error });
      return true;
    }

    try {
      const { text } = typePayload;
      performType(text);
      sendJson(res, 200, { success: true, length: text.length });
    } catch (err) {
      sendJson(res, 500, {
        error: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ── POST /api/sandbox/computer/keypress ─────────────────────────────
  if (method === "POST" && pathname === "/api/sandbox/computer/keypress") {
    const parsed = await readJsonBody(req, res);
    if (!parsed) return true;

    const keypressPayload = resolveKeypressPayload(parsed);
    if (keypressPayload.error) {
      sendJson(res, 400, { error: keypressPayload.error });
      return true;
    }

    try {
      const { keys } = keypressPayload;
      performKeypress(keys);
      sendJson(res, 200, { success: true, keys });
    } catch (err) {
      sendJson(res, 500, {
        error: `Keypress failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ── Signing routes ─────────────────────────────────────────────────

  if (method === "POST" && pathname === "/api/sandbox/sign") {
    const signer = state.signingService;
    if (!signer) {
      sendJson(res, 503, { error: "Signing service not configured" });
      return true;
    }
    const body = await readJsonBody<unknown>(req, res);
    if (body === null) return true;
    const parsed = resolveSigningRequestPayload(body);
    if ("error" in parsed) {
      sendJson(res, 400, { error: parsed.error });
      return true;
    }
    try {
      const result = await signer.submitSigningRequest(parsed.request);
      sendJson(res, result.success ? 200 : 403, result);
    } catch (err) {
      sendJson(res, 400, {
        error: `Invalid request: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/sandbox/sign/approve") {
    const signer = state.signingService;
    if (!signer) {
      sendJson(res, 503, { error: "Signing service not configured" });
      return true;
    }
    const body = await readJsonBody<{ requestId?: string }>(req, res);
    if (!body) return true;
    try {
      const { requestId } = body as { requestId: string };
      const result = await signer.approveRequest(requestId);
      sendJson(res, result.success ? 200 : 403, result);
    } catch (err) {
      sendJson(res, 400, { error: String(err) });
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/sandbox/sign/reject") {
    const signer = state.signingService;
    if (!signer) {
      sendJson(res, 503, { error: "Signing service not configured" });
      return true;
    }
    const body = await readJsonBody<{ requestId?: string }>(req, res);
    if (!body) return true;
    try {
      const { requestId } = body as { requestId: string };
      const rejected = signer.rejectRequest(requestId);
      sendJson(res, 200, { rejected });
    } catch (err) {
      sendJson(res, 400, { error: String(err) });
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/sandbox/sign/pending") {
    const signer = state.signingService;
    if (!signer) {
      sendJson(res, 503, { error: "Signing service not configured" });
      return true;
    }
    sendJson(res, 200, { pending: signer.getPendingApprovals() });
    return true;
  }

  if (method === "GET" && pathname === "/api/sandbox/sign/address") {
    const signer = state.signingService;
    if (!signer) {
      sendJson(res, 503, { error: "Signing service not configured" });
      return true;
    }
    try {
      const address = await signer.getAddress();
      sendJson(res, 200, { address });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  // ── GET /api/sandbox/capabilities ───────────────────────────────────
  if (method === "GET" && pathname === "/api/sandbox/capabilities") {
    sendJson(res, 200, detectCapabilities());
    return true;
  }

  // ── Fallthrough ─────────────────────────────────────────────────────
  sendJson(res, 404, { error: `Unknown sandbox route: ${method} ${pathname}` });
  return true;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveSigningRequestPayload(
  input: unknown,
): { request: SigningRequest } | { error: string } {
  const obj = asObject(input);
  if (!obj) {
    return { error: "Signing payload must be a JSON object" };
  }

  const requestId = obj.requestId;
  const chainId = parseFiniteInteger(obj.chainId);
  const to = obj.to;
  const value = obj.value;
  const data = obj.data;
  const nonce =
    obj.nonce === undefined ? undefined : parseFiniteInteger(obj.nonce);
  const rawGasLimit = obj.gasLimit;
  const createdAt = parseFiniteInteger(obj.createdAt);

  if (typeof requestId !== "string" || !requestId.trim()) {
    return { error: "Signing payload requires a non-empty string 'requestId'" };
  }
  if (chainId === null || chainId < 0) {
    return { error: "Signing payload requires an integer 'chainId' >= 0" };
  }
  if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
    return {
      error:
        "Signing payload requires a hex 'to' address (e.g., 0x followed by 40 hex characters)",
    };
  }
  if (typeof value !== "string" || !value.trim()) {
    return { error: "Signing payload requires a non-empty string 'value'" };
  }
  if (typeof data !== "string" || !data.trim()) {
    return { error: "Signing payload requires a non-empty string 'data'" };
  }
  if (nonce === null) {
    return { error: "'nonce' must be a non-negative integer when provided" };
  }
  if (createdAt === null) {
    return { error: "Signing payload requires an integer 'createdAt'" };
  }
  if (rawGasLimit !== undefined && typeof rawGasLimit !== "string") {
    return {
      error: "Signing payload 'gasLimit' must be a string when provided",
    };
  }

  const gasLimit = rawGasLimit?.trim();
  if (gasLimit === "") {
    return {
      error: "Signing payload 'gasLimit' cannot be empty when provided",
    };
  }

  return {
    request: {
      requestId: requestId.trim(),
      chainId,
      to: to.trim(),
      value: value.trim(),
      data,
      ...(nonce === undefined ? {} : { nonce }),
      ...(gasLimit === undefined ? {} : { gasLimit }),
      createdAt,
    },
  };
}

function parseFiniteInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  return value;
}

function resolveScreenshotRegion(input: unknown): {
  region?: { x: number; y: number; width: number; height: number };
  error?: string;
} {
  if (input === undefined || input === null) return {};
  const obj = asObject(input);
  if (!obj) return { error: "Screenshot region payload must be a JSON object" };

  const hasRegionField =
    "x" in obj || "y" in obj || "width" in obj || "height" in obj;
  if (!hasRegionField) return {};

  const x = parseFiniteInteger(obj.x);
  const y = parseFiniteInteger(obj.y);
  const width = parseFiniteInteger(obj.width);
  const height = parseFiniteInteger(obj.height);

  if (x === null || y === null || width === null || height === null) {
    return {
      error: "Region requires integer x, y, width, and height values",
    };
  }
  if (width <= 0 || height <= 0) {
    return { error: "Region width and height must be greater than 0" };
  }

  return {
    region: { x, y, width, height },
  };
}

function resolveClickPayload(input: unknown): {
  x: number;
  y: number;
  button: "left" | "right";
  error?: string;
} {
  const obj = asObject(input);
  if (!obj) {
    return {
      x: 0,
      y: 0,
      button: "left",
      error: "Click payload must be a JSON object",
    };
  }

  const x = parseFiniteInteger(obj.x);
  const y = parseFiniteInteger(obj.y);
  if (x === null || y === null) {
    return {
      x: 0,
      y: 0,
      button: "left",
      error: "Click payload requires integer x and y coordinates",
    };
  }

  const rawButton = obj.button;
  let button: "left" | "right" = "left";
  if (rawButton !== undefined) {
    if (rawButton !== "left" && rawButton !== "right") {
      return {
        x,
        y,
        button,
        error: "button must be either 'left' or 'right'",
      };
    }
    button = rawButton;
  }

  return { x, y, button };
}

function resolveTypePayload(input: unknown): { text: string; error?: string } {
  const obj = asObject(input);
  if (!obj) return { text: "", error: "Type payload must be a JSON object" };
  if (typeof obj.text !== "string") {
    return { text: "", error: "Type payload requires a string 'text' field" };
  }
  if (obj.text.length === 0) {
    return { text: "", error: "text cannot be empty" };
  }
  if (obj.text.length > MAX_COMPUTER_INPUT_LENGTH) {
    return {
      text: "",
      error: `text exceeds maximum length (${MAX_COMPUTER_INPUT_LENGTH})`,
    };
  }
  return { text: obj.text };
}

function resolveKeypressPayload(input: unknown): {
  keys: string;
  error?: string;
} {
  const obj = asObject(input);
  if (!obj) {
    return { keys: "", error: "Keypress payload must be a JSON object" };
  }
  if (typeof obj.keys !== "string") {
    return {
      keys: "",
      error: "Keypress payload requires a string 'keys' field",
    };
  }

  const keys = obj.keys.trim();
  if (!keys) return { keys: "", error: "keys cannot be empty" };
  if (keys.length > MAX_KEYPRESS_LENGTH) {
    return {
      keys: "",
      error: `keys exceeds maximum length (${MAX_KEYPRESS_LENGTH})`,
    };
  }
  if (!SAFE_KEYPRESS_PATTERN.test(keys)) {
    return {
      keys: "",
      error:
        "keys contains unsupported characters; allowed: letters, numbers, space, +, _, ., ,, :, -",
    };
  }

  return { keys };
}

function resolveAudioFormat(input: unknown): {
  format: string;
  error?: string;
} {
  if (input === undefined || input === null) return { format: "wav" };
  if (typeof input !== "string") {
    return { format: "wav", error: "format must be a string" };
  }

  const normalized = input.trim().toLowerCase();
  if (!normalized) return { format: "wav" };
  if (!/^[a-z0-9]+$/.test(normalized)) {
    return {
      format: "wav",
      error:
        "format contains unsupported characters; use one of: wav, mp3, ogg, flac, m4a",
    };
  }
  if (!ALLOWED_AUDIO_FORMATS.has(normalized)) {
    return {
      format: "wav",
      error: "format must be one of: wav, mp3, ogg, flac, m4a",
    };
  }

  return { format: normalized };
}

function runCommand(command: string, args: string[], timeout: number): void {
  execFileSync(command, args, {
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function captureScreenshot(region?: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Buffer {
  const os = platform();
  const tmpFile = join(tmpdir(), `sandbox-screenshot-${Date.now()}.png`);

  try {
    if (os === "darwin") {
      if (region) {
        runCommand(
          "screencapture",
          [
            `-R${region.x},${region.y},${region.width},${region.height}`,
            "-x",
            tmpFile,
          ],
          10000,
        );
      } else {
        runCommand("screencapture", ["-x", tmpFile], 10000);
      }
    } else if (os === "linux") {
      // Try tools in preference order
      if (commandExists("import")) {
        if (region) {
          runCommand(
            "import",
            [
              "-window",
              "root",
              "-crop",
              `${region.width}x${region.height}+${region.x}+${region.y}`,
              tmpFile,
            ],
            10000,
          );
        } else {
          runCommand("import", ["-window", "root", tmpFile], 10000);
        }
      } else if (commandExists("scrot")) {
        runCommand("scrot", [tmpFile], 10000);
      } else if (commandExists("gnome-screenshot")) {
        runCommand("gnome-screenshot", ["-f", tmpFile], 10000);
      } else {
        throw new Error(
          "No screenshot tool available. Install ImageMagick, scrot, or gnome-screenshot.",
        );
      }
    } else if (os === "win32") {
      // PowerShell screenshot
      const psCmd = [
        `Add-Type -AssemblyName System.Windows.Forms`,
        `$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds`,
        `$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)`,
        `$graphics = [System.Drawing.Graphics]::FromImage($bitmap)`,
        `$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)`,
        `$bitmap.Save('${tmpFile.replace(/\//g, "\\")}')`,
        `$graphics.Dispose()`,
        `$bitmap.Dispose()`,
      ].join("; ");
      execSync(`powershell -Command "${psCmd}"`, {
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      throw new Error(`Screenshot not supported on platform: ${os}`);
    }

    const data = readFileSync(tmpFile);
    try {
      unlinkSync(tmpFile);
    } catch {
      /* cleanup best effort */
    }
    return data;
  } catch (err) {
    // Clean up temp file on error
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function listWindows(): Array<{ id: string; title: string; app: string }> {
  const os = platform();

  if (os === "darwin") {
    try {
      const script = `
        tell application "System Events"
          set windowList to {}
          repeat with proc in (every process whose visible is true)
            try
              repeat with w in (every window of proc)
                set end of windowList to (name of proc) & "|||" & (name of w) & "|||" & (id of w as text)
              end repeat
            end try
          end repeat
          return windowList as text
        end tell`;
      const output = execSync(`osascript -e '${script}'`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return output
        .split(", ")
        .filter(Boolean)
        .map((entry) => {
          const parts = entry.split("|||");
          return {
            app: parts[0] ?? "unknown",
            title: parts[1] ?? "unknown",
            id: parts[2] ?? "0",
          };
        });
    } catch {
      return [];
    }
  }

  if (os === "linux") {
    try {
      const output = execSync(
        'wmctrl -l 2>/dev/null || xdotool search --name "" getwindowname 2>/dev/null',
        {
          encoding: "utf-8",
          timeout: 5000,
        },
      );
      return output
        .split("\n")
        .filter(Boolean)
        .map((line, i) => ({
          id: String(i),
          title: line.trim(),
          app: "unknown",
        }));
    } catch {
      return [];
    }
  }

  if (os === "win32") {
    try {
      const output = execSync(
        `powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object Id, MainWindowTitle | ConvertTo-Json"`,
        { encoding: "utf-8", timeout: 10000 },
      );
      const processes = JSON.parse(output);
      const list = Array.isArray(processes) ? processes : [processes];
      return list.map((p: { Id: number; MainWindowTitle: string }) => ({
        id: String(p.Id),
        title: p.MainWindowTitle,
        app: "unknown",
      }));
    } catch {
      return [];
    }
  }

  return [];
}

async function recordAudio(durationMs: number): Promise<Buffer> {
  const os = platform();
  const durationSec = Math.ceil(durationMs / 1000);
  const tmpFile = join(tmpdir(), `sandbox-audio-${Date.now()}.wav`);

  if (os === "darwin") {
    // Use sox (rec) on macOS
    if (commandExists("rec")) {
      execSync(`rec -q ${tmpFile} trim 0 ${durationSec}`, {
        timeout: durationMs + 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else if (commandExists("ffmpeg")) {
      execSync(
        `ffmpeg -f avfoundation -i ":0" -t ${durationSec} -y ${tmpFile} 2>/dev/null`,
        { timeout: durationMs + 10000, stdio: ["ignore", "pipe", "pipe"] },
      );
    } else {
      throw new Error(
        "No audio recording tool available. Install sox or ffmpeg.",
      );
    }
  } else if (os === "linux") {
    if (commandExists("arecord")) {
      execSync(`arecord -d ${durationSec} -f cd ${tmpFile}`, {
        timeout: durationMs + 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else if (commandExists("ffmpeg")) {
      execSync(
        `ffmpeg -f pulse -i default -t ${durationSec} -y ${tmpFile} 2>/dev/null`,
        { timeout: durationMs + 10000, stdio: ["ignore", "pipe", "pipe"] },
      );
    } else {
      throw new Error(
        "No audio recording tool available. Install alsa-utils or ffmpeg.",
      );
    }
  } else if (os === "win32") {
    // Use ffmpeg on Windows (most portable)
    if (commandExists("ffmpeg")) {
      execSync(
        `ffmpeg -f dshow -i audio="Microphone" -t ${durationSec} -y "${tmpFile.replace(/\//g, "\\")}" 2>NUL`,
        { timeout: durationMs + 10000, stdio: ["ignore", "pipe", "pipe"] },
      );
    } else {
      throw new Error("No audio recording tool available. Install ffmpeg.");
    }
  } else {
    throw new Error(`Audio recording not supported on platform: ${os}`);
  }

  const data = readFileSync(tmpFile);
  try {
    unlinkSync(tmpFile);
  } catch {
    /* cleanup */
  }
  return data;
}

async function playAudio(data: Buffer, format: string): Promise<void> {
  const os = platform();
  const tmpFile = join(tmpdir(), `sandbox-play-${Date.now()}.${format}`);
  writeFileSync(tmpFile, data);

  try {
    if (os === "darwin") {
      runCommand("afplay", [tmpFile], 60000);
    } else if (os === "linux") {
      if (commandExists("aplay")) {
        runCommand("aplay", [tmpFile], 60000);
      } else if (commandExists("paplay")) {
        runCommand("paplay", [tmpFile], 60000);
      } else if (commandExists("ffplay")) {
        runCommand("ffplay", ["-autoexit", "-nodisp", tmpFile], 60000);
      } else {
        throw new Error("No audio playback tool available.");
      }
    } else if (os === "win32") {
      const escapedPath = tmpFile.replace(/\//g, "\\").replace(/'/g, "''");
      runCommand(
        "powershell",
        [
          "-Command",
          `(New-Object Media.SoundPlayer '${escapedPath}').PlaySync()`,
        ],
        60000,
      );
    }
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* cleanup */
    }
  }
}

function toAppleScriptStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function performClick(x: number, y: number, button: "left" | "right"): void {
  const os = platform();

  if (os === "darwin") {
    // Use cliclick on macOS (brew install cliclick)
    if (commandExists("cliclick")) {
      const btn = button === "right" ? "rc" : "c";
      runCommand("cliclick", [`${btn}:${x},${y}`], 5000);
    } else {
      // AppleScript fallback
      runCommand(
        "osascript",
        ["-e", `tell application "System Events" to click at {${x}, ${y}}`],
        5000,
      );
    }
  } else if (os === "linux") {
    if (commandExists("xdotool")) {
      const btn = button === "right" ? "3" : "1";
      runCommand(
        "xdotool",
        ["mousemove", String(x), String(y), "click", btn],
        5000,
      );
    } else {
      throw new Error("xdotool required for mouse control on Linux.");
    }
  } else if (os === "win32") {
    // Use Win32 API via PowerShell to perform an actual mouse click
    const psScript = [
      `Add-Type -AssemblyName System.Windows.Forms`,
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name Win32Mouse -Namespace Win32`,
      button === "right"
        ? `[Win32.Win32Mouse]::mouse_event(0x0008, 0, 0, 0, 0); [Win32.Win32Mouse]::mouse_event(0x0010, 0, 0, 0, 0)` // right down + up
        : `[Win32.Win32Mouse]::mouse_event(0x0002, 0, 0, 0, 0); [Win32.Win32Mouse]::mouse_event(0x0004, 0, 0, 0, 0)`, // left down + up
    ].join("; ");
    runCommand("powershell", ["-Command", psScript], 5000);
  }
}

function performType(text: string): void {
  const os = platform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`t:${text}`], 10000);
    } else {
      runCommand(
        "osascript",
        [
          "-e",
          `tell application "System Events" to keystroke ${toAppleScriptStringLiteral(text)}`,
        ],
        10000,
      );
    }
  } else if (os === "linux") {
    if (commandExists("xdotool")) {
      runCommand("xdotool", ["type", "--", text], 10000);
    } else {
      throw new Error("xdotool required for keyboard input on Linux.");
    }
  } else if (os === "win32") {
    const escaped = text.replace(/'/g, "''");
    runCommand(
      "powershell",
      [
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
      ],
      10000,
    );
  }
}

function performKeypress(keys: string): void {
  const os = platform();

  if (os === "darwin") {
    if (commandExists("cliclick")) {
      runCommand("cliclick", [`kp:${keys}`], 5000);
    } else {
      const symbolicKeyCodes: Record<string, number> = {
        return: 36,
        enter: 36,
        tab: 48,
        space: 49,
        escape: 53,
        esc: 53,
        left: 123,
        right: 124,
        down: 125,
        up: 126,
      };
      const normalized = keys.trim().toLowerCase();
      const mappedCode = symbolicKeyCodes[normalized];
      const numericCode =
        mappedCode ??
        (Number.isInteger(Number(keys.trim())) ? Number(keys.trim()) : null);

      if (numericCode !== null) {
        runCommand(
          "osascript",
          ["-e", `tell application "System Events" to key code ${numericCode}`],
          5000,
        );
      } else {
        runCommand(
          "osascript",
          [
            "-e",
            `tell application "System Events" to keystroke ${toAppleScriptStringLiteral(keys)}`,
          ],
          5000,
        );
      }
    }
  } else if (os === "linux") {
    if (commandExists("xdotool")) {
      runCommand("xdotool", ["key", keys], 5000);
    } else {
      throw new Error("xdotool required for key input on Linux.");
    }
  } else if (os === "win32") {
    const escaped = keys.replace(/'/g, "''");
    runCommand(
      "powershell",
      [
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
      ],
      5000,
    );
  }
}

function detectCapabilities(): Record<
  string,
  { available: boolean; tool: string }
> {
  const os = platform();
  const caps: Record<string, { available: boolean; tool: string }> = {};

  // Screenshot
  if (os === "darwin") {
    caps.screenshot = { available: true, tool: "screencapture (built-in)" };
  } else if (os === "linux") {
    if (commandExists("import"))
      caps.screenshot = { available: true, tool: "ImageMagick import" };
    else if (commandExists("scrot"))
      caps.screenshot = { available: true, tool: "scrot" };
    else if (commandExists("gnome-screenshot"))
      caps.screenshot = { available: true, tool: "gnome-screenshot" };
    else
      caps.screenshot = {
        available: false,
        tool: "none (install ImageMagick, scrot, or gnome-screenshot)",
      };
  } else if (os === "win32") {
    caps.screenshot = { available: true, tool: "PowerShell System.Drawing" };
  } else {
    caps.screenshot = { available: false, tool: "unsupported platform" };
  }

  // Audio record
  if (os === "darwin") {
    if (commandExists("rec"))
      caps.audioRecord = { available: true, tool: "sox rec" };
    else if (commandExists("ffmpeg"))
      caps.audioRecord = { available: true, tool: "ffmpeg" };
    else
      caps.audioRecord = {
        available: false,
        tool: "none (install sox or ffmpeg)",
      };
  } else if (os === "linux") {
    if (commandExists("arecord"))
      caps.audioRecord = { available: true, tool: "arecord" };
    else if (commandExists("ffmpeg"))
      caps.audioRecord = { available: true, tool: "ffmpeg" };
    else
      caps.audioRecord = {
        available: false,
        tool: "none (install alsa-utils or ffmpeg)",
      };
  } else if (os === "win32") {
    if (commandExists("ffmpeg"))
      caps.audioRecord = { available: true, tool: "ffmpeg" };
    else caps.audioRecord = { available: false, tool: "none (install ffmpeg)" };
  } else {
    caps.audioRecord = { available: false, tool: "unsupported" };
  }

  // Audio play
  if (os === "darwin")
    caps.audioPlay = { available: true, tool: "afplay (built-in)" };
  else if (os === "linux") {
    if (commandExists("aplay"))
      caps.audioPlay = { available: true, tool: "aplay" };
    else if (commandExists("paplay"))
      caps.audioPlay = { available: true, tool: "paplay" };
    else if (commandExists("ffplay"))
      caps.audioPlay = { available: true, tool: "ffplay" };
    else caps.audioPlay = { available: false, tool: "none" };
  } else if (os === "win32") {
    caps.audioPlay = { available: true, tool: "PowerShell SoundPlayer" };
  } else {
    caps.audioPlay = { available: false, tool: "unsupported" };
  }

  // Mouse/keyboard control
  if (os === "darwin") {
    if (commandExists("cliclick"))
      caps.computerUse = { available: true, tool: "cliclick" };
    else caps.computerUse = { available: true, tool: "AppleScript (limited)" };
  } else if (os === "linux") {
    if (commandExists("xdotool"))
      caps.computerUse = { available: true, tool: "xdotool" };
    else
      caps.computerUse = { available: false, tool: "none (install xdotool)" };
  } else if (os === "win32") {
    caps.computerUse = { available: true, tool: "PowerShell SendKeys" };
  } else {
    caps.computerUse = { available: false, tool: "unsupported" };
  }

  // Window listing
  if (os === "darwin")
    caps.windowList = { available: true, tool: "AppleScript" };
  else if (os === "linux") {
    if (commandExists("wmctrl"))
      caps.windowList = { available: true, tool: "wmctrl" };
    else if (commandExists("xdotool"))
      caps.windowList = { available: true, tool: "xdotool" };
    else
      caps.windowList = {
        available: false,
        tool: "none (install wmctrl or xdotool)",
      };
  } else if (os === "win32") {
    caps.windowList = { available: true, tool: "PowerShell Get-Process" };
  } else {
    caps.windowList = { available: false, tool: "unsupported" };
  }

  // Browser
  caps.browser = { available: true, tool: "CDP via sandbox browser container" };

  // Shell
  caps.shell = { available: true, tool: "docker exec" };

  return caps;
}

function getPlatformInfo(): Record<string, string | boolean> {
  const os = platform();
  let dockerInstalled = false;
  let dockerRunning = false;
  let appleContainerAvailable = false;

  // Check if docker binary exists (installed)
  try {
    const which = os === "win32" ? "where" : "which";
    execSync(`${which} docker`, { stdio: "ignore", timeout: 3000 });
    dockerInstalled = true;
  } catch {
    /* not installed */
  }

  // Check if docker daemon is running (docker info succeeds only when daemon is up)
  if (dockerInstalled) {
    try {
      execSync("docker info", { stdio: "ignore", timeout: 5000 });
      dockerRunning = true;
    } catch {
      /* installed but not running */
    }
  }

  if (os === "darwin") {
    try {
      execSync("which container", { stdio: "ignore", timeout: 3000 });
      appleContainerAvailable = true;
    } catch {
      /* */
    }
  }

  return {
    platform: os,
    arch: require("node:os").arch(),
    dockerInstalled,
    dockerRunning,
    // Legacy compat: dockerAvailable = running (old clients check this)
    dockerAvailable: dockerRunning,
    appleContainerAvailable,
    wsl2: os === "win32" ? isWsl2Available() : false,
    recommended:
      os === "darwin" && appleContainerAvailable ? "apple-container" : "docker",
  };
}

function isWsl2Available(): boolean {
  try {
    execSync("wsl --status", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function attemptDockerStart(): {
  success: boolean;
  message: string;
  waitMs: number;
} {
  const os = platform();

  try {
    if (os === "darwin") {
      execSync('open -a "Docker"', { timeout: 5000, stdio: "ignore" });
      return {
        success: true,
        message: "Docker Desktop is starting on macOS. Give it a moment~",
        waitMs: 15000,
      };
    }

    if (os === "win32") {
      // Try common install locations
      const paths = [
        '"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"',
        '"C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe"',
      ];
      let started = false;
      for (const p of paths) {
        try {
          execSync(`start "" ${p}`, {
            timeout: 5000,
            stdio: "ignore",
            shell: "cmd.exe",
          });
          started = true;
          break;
        } catch {
          /* try next path */
        }
      }
      if (!started) {
        // Try via start menu
        execSync('start "" "Docker Desktop"', {
          timeout: 5000,
          stdio: "ignore",
          shell: "cmd.exe",
        });
      }
      return {
        success: true,
        message:
          "Docker Desktop is starting on Windows. This may take 30 seconds~",
        waitMs: 30000,
      };
    }

    if (os === "linux") {
      // Try systemctl first (most common)
      try {
        execSync("sudo systemctl start docker", {
          timeout: 10000,
          stdio: "ignore",
        });
        return {
          success: true,
          message: "Docker daemon started via systemctl",
          waitMs: 5000,
        };
      } catch {
        /* systemctl may not be available */
      }

      // Try service command
      try {
        execSync("sudo service docker start", {
          timeout: 10000,
          stdio: "ignore",
        });
        return {
          success: true,
          message: "Docker daemon started via service",
          waitMs: 5000,
        };
      } catch {
        /* */
      }

      return {
        success: false,
        message:
          "Could not auto-start Docker on Linux. Run: sudo systemctl start docker",
        waitMs: 0,
      };
    }

    return {
      success: false,
      message: `Auto-start not supported on ${os}`,
      waitMs: 0,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      waitMs: 0,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function commandExists(cmd: string): boolean {
  try {
    const which = platform() === "win32" ? "where" : "which";
    execSync(`${which} ${cmd}`, { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, data: object): void {
  sendJsonResponse(res, data, status);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return readRequestBody(req, {
    maxBytes: 10 * 1024 * 1024,
    returnNullOnTooLarge: true,
    returnNullOnError: true,
    destroyOnTooLarge: true,
  });
}

function readJsonBody<T = unknown>(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<T | null> {
  return parseJsonBody(req, res, {
    maxBytes: 10 * 1024 * 1024,
    requireObject: false,
    readErrorStatus: 400,
    parseErrorStatus: 400,
    readErrorMessage: "Missing request body",
    parseErrorMessage: "Invalid JSON in request body",
  });
}
