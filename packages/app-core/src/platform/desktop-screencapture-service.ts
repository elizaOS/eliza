/**
 * Child-side `ScreenCaptureService` that proxies to the electrobun desktop host.
 *
 * The real screen/frame capture lives in the electrobun MAIN process
 * (`platforms/electrobun/src/native/screencapture.ts`), but the agent runs as a
 * spawned child, so `runtime.getService(SCREEN_CAPTURE)` would otherwise be null
 * and the streaming routes stay inert (#12249). The host starts a loopback HTTP
 * bridge (`screencapture-bridge-server.ts`) and hands the child its URL + token
 * via `ELIZA_DESKTOP_SCREENCAPTURE_URL` / `_TOKEN`; this service reads that env,
 * registers as `ServiceType.SCREEN_CAPTURE`, and forwards start/stop over HTTP —
 * mirroring the proven browser-workspace bridge pattern in @elizaos/plugin-browser.
 *
 * `isFrameCaptureActive()` is synchronous per the interface, so it reports a
 * local cache set on start/stop rather than round-tripping to the host.
 */

import {
  type IAgentRuntime,
  IScreenCaptureService,
  logger,
  type ScreenCaptureFrameOptions,
  type Service,
} from "@elizaos/core";

/** Bridge address + shared secret the electrobun host published to the child. */
export interface ScreenCaptureBridgeConfig {
  baseUrl: string;
  token?: string;
}

/** How long to wait on a bridge control request before giving up. */
const BRIDGE_REQUEST_TIMEOUT_MS = 10_000;

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the desktop screen-capture bridge from env, or `null` when it is not
 * configured (mobile/web/cloud, or the host never started the bridge). A `null`
 * result is the signal to skip registration and let capture fall back to another
 * mode, exactly like the browser-workspace bridge.
 */
export function resolveScreenCaptureBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ScreenCaptureBridgeConfig | null {
  const baseUrl = normalizeEnvValue(env.ELIZA_DESKTOP_SCREENCAPTURE_URL);
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/{1,1024}$/, ""),
    token: normalizeEnvValue(env.ELIZA_DESKTOP_SCREENCAPTURE_TOKEN),
  };
}

async function requestBridge<T>(
  config: ScreenCaptureBridgeConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  headers.set("Accept", "application/json");
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  if (config.token) headers.set("Authorization", `Bearer ${config.token}`);

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response
      .text()
      .then((text) => text.trim().slice(0, 240))
      .catch(() => "");
    throw new Error(
      `screencapture bridge ${path} failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * Registered as `ServiceType.SCREEN_CAPTURE` in the desktop child runtime.
 * `@elizaos/plugin-streaming` resolves it via `getService` and drives
 * start/stop; each call is proxied to the host's native capture over the bridge.
 */
export class DesktopScreenCaptureService extends IScreenCaptureService {
  private readonly bridge: ScreenCaptureBridgeConfig;
  private active = false;

  // The `bridge` arg stays optional so the class matches the runtime's
  // `ServiceClass` shape (`new (runtime?) => Service`); when omitted it is
  // resolved from env, and an absent config is a real misconfiguration since
  // registration is env-gated.
  constructor(runtime?: IAgentRuntime, bridge?: ScreenCaptureBridgeConfig) {
    super(runtime);
    const resolved = bridge ?? resolveScreenCaptureBridgeConfig();
    if (!resolved) {
      throw new Error(
        "[DesktopScreenCaptureService] no bridge configured (ELIZA_DESKTOP_SCREENCAPTURE_URL unset)",
      );
    }
    this.bridge = resolved;
  }

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new DesktopScreenCaptureService(runtime);
    logger.info(
      `[DesktopScreenCaptureService] desktop capture bridged to ${service.bridge.baseUrl}`,
    );
    return service;
  }

  isFrameCaptureActive(): boolean {
    return this.active;
  }

  async startFrameCapture(options: ScreenCaptureFrameOptions): Promise<void> {
    const result = await requestBridge<{ available: boolean; reason?: string }>(
      this.bridge,
      "/frame-capture/start",
      { method: "POST", body: JSON.stringify(options ?? {}) },
    );
    if (!result.available) {
      this.active = false;
      throw new Error(
        `[DesktopScreenCaptureService] host declined frame capture${result.reason ? `: ${result.reason}` : ""}`,
      );
    }
    this.active = true;
  }

  stopFrameCapture(): void {
    // Optimistically clear local state; the host stop is fire-and-forget so a
    // slow/failed teardown never blocks the caller (interface returns void).
    this.active = false;
    void requestBridge(this.bridge, "/frame-capture/stop", {
      method: "POST",
    }).catch((err) => {
      logger.warn(
        `[DesktopScreenCaptureService] stop request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async stop(): Promise<void> {
    this.stopFrameCapture();
  }
}

/**
 * Register the proxy service on the desktop child runtime when the host bridge
 * is configured. No-op (returns false) on mobile/web/cloud or before the host
 * publishes the bridge env, so non-desktop boots are unaffected.
 */
export async function registerDesktopScreenCaptureService(
  runtime: IAgentRuntime,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!resolveScreenCaptureBridgeConfig(env)) return false;
  if (runtime.getService(DesktopScreenCaptureService.serviceType)) return true;
  await runtime.registerService(DesktopScreenCaptureService);
  return true;
}
