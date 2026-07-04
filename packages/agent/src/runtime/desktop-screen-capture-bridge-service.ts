import {
  type IAgentRuntime,
  IScreenCaptureService,
  logger,
  type ScreenCaptureFrameOptions,
  ServiceType,
} from "@elizaos/core";
import { resolveDesktopApiPort } from "@elizaos/shared";

export const DESKTOP_SCREEN_CAPTURE_BRIDGE_URL_ENV =
  "ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_URL";
export const DESKTOP_SCREEN_CAPTURE_BRIDGE_TOKEN_ENV =
  "ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_TOKEN";

type RuntimeEnv = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export interface DesktopScreenCaptureBridgeConfig {
  baseUrl: string;
  token: string;
  apiBase: string;
}

function isLoopbackBridgeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

export function resolveDesktopScreenCaptureBridgeConfig(
  env: RuntimeEnv = process.env,
): DesktopScreenCaptureBridgeConfig | null {
  const baseUrl = env[DESKTOP_SCREEN_CAPTURE_BRIDGE_URL_ENV]?.trim();
  const token = env[DESKTOP_SCREEN_CAPTURE_BRIDGE_TOKEN_ENV]?.trim();
  if (!baseUrl || !token) return null;
  if (!isLoopbackBridgeUrl(baseUrl)) return null;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
    apiBase: `http://127.0.0.1:${resolveDesktopApiPort(env)}`,
  };
}

export class DesktopScreenCaptureBridgeService extends IScreenCaptureService {
  static override readonly serviceType = ServiceType.SCREEN_CAPTURE;
  private static bridgeConfig: DesktopScreenCaptureBridgeConfig | null = null;

  private active = false;
  private readonly bridgeConfig: DesktopScreenCaptureBridgeConfig;
  private readonly fetchImpl: FetchLike;

  constructor(
    runtime?: IAgentRuntime,
    bridgeConfig: DesktopScreenCaptureBridgeConfig | null = DesktopScreenCaptureBridgeService.bridgeConfig,
    fetchImpl: FetchLike = fetch,
  ) {
    super(runtime);
    if (!bridgeConfig) {
      throw new Error("Desktop screen-capture bridge is not configured");
    }
    this.bridgeConfig = bridgeConfig;
    this.fetchImpl = fetchImpl;
  }

  static configure(config: DesktopScreenCaptureBridgeConfig | null): void {
    DesktopScreenCaptureBridgeService.bridgeConfig = config;
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<DesktopScreenCaptureBridgeService> {
    if (!DesktopScreenCaptureBridgeService.bridgeConfig) {
      throw new Error("Desktop screen-capture bridge is not configured");
    }
    return new DesktopScreenCaptureBridgeService(runtime);
  }

  override async stop(): Promise<void> {
    if (!this.active) return;
    try {
      await this.stopFrameCapture();
    } catch (error) {
      logger.debug(
        `[desktop-screen-capture] stop during service shutdown failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  override isFrameCaptureActive(): boolean {
    return this.active;
  }

  override async startFrameCapture(
    options: ScreenCaptureFrameOptions = {},
  ): Promise<void> {
    const result = await this.requestJson<{
      available?: boolean;
      reason?: string;
    }>("/frame-capture/start", {
      method: "POST",
      body: JSON.stringify({
        ...options,
        apiBase: this.bridgeConfig.apiBase,
        endpoint: options.endpoint ?? "/api/stream/frame",
      }),
    });
    if (result.available === false) {
      throw new Error(result.reason ?? "desktop screen capture unavailable");
    }
    this.active = true;
  }

  override stopFrameCapture(): void {
    this.active = false;
    void this.requestJson("/frame-capture/stop", { method: "POST" }).catch(
      (error) => {
        logger.debug(
          `[desktop-screen-capture] stop bridge request failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
  }

  private async requestJson<T = Record<string, unknown>>(
    pathname: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetchImpl(
      `${this.bridgeConfig.baseUrl}${pathname}`,
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.bridgeConfig.token}`,
          ...init.headers,
        },
      },
    );
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const error =
        typeof body.error === "string"
          ? body.error
          : `desktop screen-capture bridge returned ${response.status}`;
      throw new Error(error);
    }
    return body as T;
  }
}

type RuntimeWithServiceRegistration = Pick<
  IAgentRuntime,
  "getService" | "getServiceLoadPromise" | "registerService"
>;

export async function registerDesktopScreenCaptureBridgeService(
  runtime: RuntimeWithServiceRegistration,
  env: RuntimeEnv = process.env,
): Promise<boolean> {
  if (runtime.getService(ServiceType.SCREEN_CAPTURE)) {
    return false;
  }

  const config = resolveDesktopScreenCaptureBridgeConfig(env);
  DesktopScreenCaptureBridgeService.configure(config);
  if (!config) {
    return false;
  }

  await runtime.registerService(DesktopScreenCaptureBridgeService);
  await runtime.getServiceLoadPromise(ServiceType.SCREEN_CAPTURE);
  logger.info("[desktop-screen-capture] Registered Electrobun bridge service");
  return true;
}

export function _resetDesktopScreenCaptureBridgeServiceConfig(): void {
  DesktopScreenCaptureBridgeService.configure(null);
}
