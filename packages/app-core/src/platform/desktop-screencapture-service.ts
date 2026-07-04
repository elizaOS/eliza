/**
 * Child-runtime proxy for desktop frame capture owned by the Electrobun host.
 *
 * The desktop shell runs native screen capture in its main process while the
 * Eliza runtime runs as a spawned child. This service registers the core
 * `screen_capture` service in the child runtime and forwards control calls over
 * the host loopback bridge published through environment variables.
 */

import {
  type IAgentRuntime,
  IScreenCaptureService,
  logger,
  type ScreenCaptureFrameOptions,
  type Service,
  ServiceType,
} from "@elizaos/core";
import { resolveDesktopApiPort } from "@elizaos/shared";

const BRIDGE_REQUEST_TIMEOUT_MS = 10_000;

export interface DesktopScreenCaptureBridgeConfig {
  baseUrl: string;
  token: string;
}

type BridgeStartResponse = {
  available: boolean;
  reason?: string;
};

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveDesktopScreenCaptureBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): DesktopScreenCaptureBridgeConfig | null {
  const baseUrl = normalizeEnvValue(env.ELIZA_DESKTOP_SCREENCAPTURE_URL);
  const token = normalizeEnvValue(env.ELIZA_DESKTOP_SCREENCAPTURE_TOKEN);
  if (!baseUrl || !token) return null;
  return {
    baseUrl: baseUrl.replace(/\/{1,1024}$/, ""),
    token,
  };
}

export function resolveDesktopScreenCaptureApiBase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const port = resolveDesktopApiPort(env);
  return `http://127.0.0.1:${port}`;
}

async function readBridgeError(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 240);
  } catch {
    return "";
  }
}

async function requestBridge<T>(
  config: DesktopScreenCaptureBridgeConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  headers.set("Accept", "application/json");
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Authorization", `Bearer ${config.token}`);

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await readBridgeError(response);
    throw new Error(
      `desktop screen-capture bridge ${path} failed (${response.status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }

  return (await response.json()) as T;
}

export class DesktopScreenCaptureService extends IScreenCaptureService {
  private readonly bridgeConfig: DesktopScreenCaptureBridgeConfig;
  private active = false;

  constructor(
    runtime?: IAgentRuntime,
    bridgeConfig?: DesktopScreenCaptureBridgeConfig,
  ) {
    super(runtime);
    const resolvedConfig =
      bridgeConfig ?? resolveDesktopScreenCaptureBridgeConfig();
    if (!resolvedConfig) {
      throw new Error(
        "[DesktopScreenCaptureService] desktop screen-capture bridge is not configured",
      );
    }
    this.bridgeConfig = resolvedConfig;
  }

  static override async start(runtime: IAgentRuntime): Promise<Service> {
    const config = resolveDesktopScreenCaptureBridgeConfig();
    if (!config) {
      throw new Error(
        "[DesktopScreenCaptureService] desktop screen-capture bridge is not configured",
      );
    }
    logger.info(
      `[DesktopScreenCaptureService] bridge configured at ${config.baseUrl}`,
    );
    return new DesktopScreenCaptureService(runtime, config);
  }

  isFrameCaptureActive(): boolean {
    return this.active;
  }

  async startFrameCapture(options: ScreenCaptureFrameOptions): Promise<void> {
    const payload = {
      ...options,
      apiBase: resolveDesktopScreenCaptureApiBase(),
    };
    const result = await requestBridge<BridgeStartResponse>(
      this.bridgeConfig,
      "/frame-capture/start",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    if (!result.available) {
      this.active = false;
      throw new Error(
        `[DesktopScreenCaptureService] host rejected frame capture${
          result.reason ? `: ${result.reason}` : ""
        }`,
      );
    }
    this.active = true;
  }

  stopFrameCapture(): void {
    this.active = false;
    void requestBridge(this.bridgeConfig, "/frame-capture/stop", {
      method: "POST",
    }).catch((err: unknown) => {
      logger.warn(
        `[DesktopScreenCaptureService] stop request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  override async stop(): Promise<void> {
    this.active = false;
    await requestBridge(this.bridgeConfig, "/frame-capture/stop", {
      method: "POST",
    }).catch((err: unknown) => {
      logger.warn(
        `[DesktopScreenCaptureService] stop request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
}

export async function registerDesktopScreenCaptureService(
  runtime: IAgentRuntime,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!resolveDesktopScreenCaptureBridgeConfig(env)) return false;
  if (runtime.getService(ServiceType.SCREEN_CAPTURE)) return true;
  if (!runtime.hasService(ServiceType.SCREEN_CAPTURE)) {
    await runtime.registerService(DesktopScreenCaptureService);
  }
  await runtime.getServiceLoadPromise(ServiceType.SCREEN_CAPTURE);
  return runtime.getService(ServiceType.SCREEN_CAPTURE) !== null;
}
