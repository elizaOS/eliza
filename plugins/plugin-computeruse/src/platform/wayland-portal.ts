/**
 * xdg-desktop-portal screenshot sidecar for Wayland sessions, where direct
 * framebuffer capture is blocked. Drives the org.freedesktop.portal.Screenshot
 * D-Bus method via an embedded Python helper and returns the captured file,
 * raising a typed permission error when the portal denies the request.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { commandExists } from "./helpers.js";
import { createPermissionDeniedError } from "./permissions.js";

const PORTAL_BUS_NAME = "org.freedesktop.portal.Desktop";
const PORTAL_OBJECT_PATH = "/org/freedesktop/portal/desktop";
const PORTAL_SCREENSHOT_METHOD = "org.freedesktop.portal.Screenshot.Screenshot";
const DEFAULT_TIMEOUT_MS = 15000;

const WAYLAND_PORTAL_HELPER = String.raw`
import os
import re
import select
import subprocess
import sys
import time
import uuid

bus_name = "org.freedesktop.portal.Desktop"
object_path = "/org/freedesktop/portal/desktop"
method = "org.freedesktop.portal.Screenshot.Screenshot"
timeout_ms = int(os.environ.get("ELIZA_WAYLAND_PORTAL_TIMEOUT_MS", "15000"))
interactive = os.environ.get("ELIZA_WAYLAND_PORTAL_INTERACTIVE", "0") == "1"
token = "eliza_" + str(os.getpid()) + "_" + uuid.uuid4().hex
options = "{'handle_token': <'" + token + "'>, 'interactive': <" + ("true" if interactive else "false") + ">}"

monitor = subprocess.Popen(
    ["gdbus", "monitor", "--session", "--dest", bus_name],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
)

try:
    time.sleep(0.05)
    call = subprocess.run(
        [
            "gdbus",
            "call",
            "--session",
            "--dest",
            bus_name,
            "--object-path",
            object_path,
            "--method",
            method,
            "",
            options,
        ],
        capture_output=True,
        text=True,
        timeout=max(1, timeout_ms / 1000),
    )
    if call.returncode != 0:
        print(call.stderr.strip() or call.stdout.strip() or "portal screenshot call failed", file=sys.stderr)
        sys.exit(2)

    match = re.search(r"objectpath '([^']+)'", call.stdout)
    if not match:
        print("portal screenshot call did not return a request handle: " + call.stdout.strip(), file=sys.stderr)
        sys.exit(3)

    handle = match.group(1)
    deadline = time.monotonic() + (timeout_ms / 1000)
    buffer = ""

    while time.monotonic() < deadline:
        remaining = max(0, min(0.5, deadline - time.monotonic()))
        ready, _, _ = select.select([monitor.stdout], [], [], remaining)
        if not ready:
            continue
        line = monitor.stdout.readline()
        if not line:
            continue
        buffer += line
        if len(buffer) > 65536:
            buffer = buffer[-65536:]
        if handle not in buffer:
            continue
        tail = buffer[buffer.rfind(handle):]
        response = re.search(r"uint32\s+(\d+)", tail)
        if not response:
            continue
        response_code = int(response.group(1))
        if response_code != 0:
            print("portal screenshot request was denied or cancelled (response=%d)" % response_code, file=sys.stderr)
            sys.exit(10 + response_code)
        uri = re.search(r"['\"]uri['\"]\s*:\s*<['\"]([^'\"]+)['\"]>", tail)
        if uri:
            print(uri.group(1))
            sys.exit(0)

    print("timed out waiting for portal screenshot response", file=sys.stderr)
    sys.exit(4)
finally:
    monitor.terminate()
    try:
        monitor.wait(timeout=1)
    except Exception:
        monitor.kill()
`;

export interface WaylandPortalCaptureOptions {
  readonly interactive?: boolean;
  readonly timeoutMs?: number;
}

export interface PortalScreenshotResponse {
  readonly responseCode: number;
  readonly uri?: string;
}

interface WaylandSessionEnv {
  readonly WAYLAND_DISPLAY?: string;
  readonly XDG_SESSION_TYPE?: string;
}

export function isWaylandSession(env?: WaylandSessionEnv): boolean {
  const sessionType = (env?.XDG_SESSION_TYPE ?? process.env.XDG_SESSION_TYPE)
    ?.trim()
    .toLowerCase();
  const waylandDisplay =
    (env?.WAYLAND_DISPLAY ?? process.env.WAYLAND_DISPLAY)?.trim() ?? "";
  return sessionType === "wayland" || waylandDisplay.length > 0;
}

export function canUseWaylandScreenshotPortal(): boolean {
  return (
    isWaylandSession() && commandExists("python3") && commandExists("gdbus")
  );
}

export function captureWaylandPortalScreenshot(
  tmpFile: string,
  options: WaylandPortalCaptureOptions = {},
): void {
  if (!isWaylandSession()) {
    throw new Error(
      "Wayland screenshot portal requested outside a Wayland session.",
    );
  }
  if (!commandExists("python3") || !commandExists("gdbus")) {
    throw new Error(
      "Wayland screenshot portal requires python3 and gdbus on PATH.",
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let uri: string;
  try {
    uri = execFileSync("python3", ["-c", WAYLAND_PORTAL_HELPER], {
      encoding: "utf-8",
      timeout: timeoutMs + 2000,
      env: {
        ...process.env,
        ELIZA_WAYLAND_PORTAL_INTERACTIVE: options.interactive ? "1" : "0",
        ELIZA_WAYLAND_PORTAL_TIMEOUT_MS: String(timeoutMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const message = commandErrorMessage(error);
    if (/denied|cancelled|canceled/i.test(message)) {
      throw createPermissionDeniedError({
        permissionType: "screen_recording",
        operation: "screenshot_capture",
        message:
          "Wayland screenshot permission was denied or cancelled by the portal.",
        details: message,
      });
    }
    throw error;
  }

  const sourcePath = portalFileUriToPath(uri);
  copyFileSync(sourcePath, tmpFile);
}

function commandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const parts: string[] = [];
  const candidate = error as {
    message?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };
  for (const value of [candidate.message, candidate.stderr, candidate.stdout]) {
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    } else if (Buffer.isBuffer(value) && value.length > 0) {
      parts.push(value.toString("utf-8"));
    }
  }
  return parts.join("\n") || String(error);
}

export function parsePortalRequestHandle(output: string): string | null {
  return output.match(/objectpath '([^']+)'/)?.[1] ?? null;
}

export function parsePortalScreenshotResponse(
  output: string,
  handle?: string,
): PortalScreenshotResponse | null {
  const source =
    handle && output.includes(handle)
      ? output.slice(output.lastIndexOf(handle))
      : output;
  const responseCodeText = source.match(/uint32\s+(\d+)/)?.[1];
  if (!responseCodeText) return null;

  const responseCode = Number.parseInt(responseCodeText, 10);
  const uri = source.match(/['"]uri['"]\s*:\s*<['"]([^'"]+)['"]>/)?.[1];
  return Number.isFinite(responseCode)
    ? { responseCode, ...(uri ? { uri } : {}) }
    : null;
}

export function portalFileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error(
      `Wayland screenshot portal returned a non-file URI: ${uri}`,
    );
  }
  // A Wayland portal always hands back a POSIX file path (the portal is
  // Linux-only at runtime). Parse it host-independently rather than via
  // node:url's fileURLToPath, which rejects a POSIX `file://` URI on Windows
  // with "File URL path must be absolute" — that threw inside the otherwise
  // cross-platform unit lane (and would crash any Windows-hosted caller). The
  // WHATWG URL parse + percent-decode yields the same path Linux produced.
  const { hostname, pathname } = new URL(uri);
  if (hostname && hostname !== "localhost") {
    throw new Error(
      `Wayland screenshot portal returned a non-local file URI: ${uri}`,
    );
  }
  return decodeURIComponent(pathname);
}

export const WAYLAND_PORTAL_DBUS_TARGET = {
  busName: PORTAL_BUS_NAME,
  objectPath: PORTAL_OBJECT_PATH,
  method: PORTAL_SCREENSHOT_METHOD,
} as const;
