// === Phase 5D: extracted from main.tsx ===
// Mobile (iOS/Android) device bridge + agent tunnel + background runner
// orchestration. The device bridge tunnels llama.cpp + native plugin calls
// from the WebView to the on-device agent; the agent tunnel exposes the
// local agent over a relay for tunnel-to-mobile pairings; the background
// runner keeps the host informed of apiBase + auth token so it can serve
// requests when the WebView is backgrounded.

import { BackgroundRunner } from "@capacitor/background-runner";
import type { PluginListenerHandle } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Agent } from "@elizaos/capacitor-agent";
import type { DeviceBridgeClient } from "@elizaos/capacitor-llama";
import {
  getBootConfig,
  IOS_LOCAL_AGENT_IPC_BASE,
  MOBILE_LOCAL_AGENT_API_BASE,
} from "@elizaos/ui";
import { apiBaseToDeviceBridgeUrl, type IosRuntimeConfig } from "./ios-runtime";
import type { UrlTrustPolicy } from "./url-trust-policy";

const BACKGROUND_RUNNER_LABEL = "eliza-tasks";
const BACKGROUND_RUNNER_CONFIG_RETRY_MS = 5_000;

export interface MobileBridgeContext {
  isNative: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  platform: string;
  logPrefix: string;
  deviceBridgeIdKey: string;
  trustPolicy: UrlTrustPolicy;
  getIosRuntimeConfig: () => IosRuntimeConfig;
}

export function createMobileBridges(ctx: MobileBridgeContext) {
  let deviceBridgeClient: DeviceBridgeClient | null = null;
  let deviceBridgeStartPromise: Promise<void> | null = null;
  let agentTunnelListener: PluginListenerHandle | null = null;
  let agentTunnelStartPromise: Promise<void> | null = null;
  let runtimeModeListenerInstalled = false;

  async function getOrCreateDeviceBridgeId(): Promise<string> {
    const existing = await Preferences.get({ key: ctx.deviceBridgeIdKey });
    if (existing.value?.trim()) return existing.value.trim();
    const prefix = ctx.isAndroid ? "android" : ctx.isIOS ? "ios" : "mobile";
    const generated =
      globalThis.crypto?.randomUUID?.() ??
      `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await Preferences.set({ key: ctx.deviceBridgeIdKey, value: generated });
    return generated;
  }

  function resolveDeviceBridgeUrl(config: IosRuntimeConfig): string | null {
    if (config.deviceBridgeUrl) {
      return ctx.trustPolicy.isTrustedNativeWebSocketUrl(config.deviceBridgeUrl)
        ? config.deviceBridgeUrl
        : null;
    }
    // cloud-hybrid: paired phone dials a remote agent via the cloud apiBase.
    // Android local: the foreground agent service owns the loopback API and
    // the WebView dials its device bridge for native llama.cpp calls.
    // iOS local: requests are handled by the in-process ITTP route kernel;
    // a loopback WebSocket bridge is unsafe in simulator runs where host
    // adb port forwarding can expose another device's agent.
    if (config.mode === "local" && ctx.isIOS) return null;
    if (config.mode === "local" && ctx.isAndroid) {
      return apiBaseToDeviceBridgeUrl(MOBILE_LOCAL_AGENT_API_BASE);
    }
    if (config.mode !== "cloud-hybrid" && config.mode !== "local") return null;
    const apiBase = getBootConfig().apiBase?.trim();
    if (!apiBase) return null;
    try {
      const bridgeUrl = apiBaseToDeviceBridgeUrl(apiBase);
      return ctx.trustPolicy.isTrustedNativeWebSocketUrl(bridgeUrl)
        ? bridgeUrl
        : null;
    } catch {
      return null;
    }
  }

  async function readAndroidLocalAgentToken(): Promise<string | undefined> {
    if (!ctx.isAndroid) return undefined;
    try {
      const result = await Agent.getLocalAgentToken?.();
      const token = result?.token?.trim();
      return token ? token : undefined;
    } catch {
      return undefined;
    }
  }

  async function configureBackgroundRunner(retry = 0): Promise<void> {
    if (!ctx.isNative || (!ctx.isIOS && !ctx.isAndroid)) return;

    const runtimeConfig = ctx.getIosRuntimeConfig();
    const bootConfig = getBootConfig();
    const bootApiBase = bootConfig.apiBase?.trim();
    let authToken =
      bootConfig.apiToken?.trim() ||
      runtimeConfig.apiToken?.trim() ||
      undefined;

    if (ctx.isAndroid && runtimeConfig.mode === "local") {
      authToken = (await readAndroidLocalAgentToken()) ?? authToken;
    }

    const details: Record<string, unknown> = {
      platform: ctx.platform,
      mode: runtimeConfig.mode,
    };
    const apiBase = bootApiBase || runtimeConfig.apiBase?.trim();
    if (apiBase) details.apiBase = apiBase;
    if (authToken) details.authToken = authToken;
    if (ctx.isAndroid && runtimeConfig.mode === "local") {
      details.localApiBase = MOBILE_LOCAL_AGENT_API_BASE;
    }
    if (ctx.isIOS && runtimeConfig.mode === "local") {
      details.localApiBase = IOS_LOCAL_AGENT_IPC_BASE;
      details.localRouteKernel =
        runtimeConfig.fullBun || ctx.trustPolicy.isNativeIosStoreBuild()
          ? "bun-host-ipc"
          : "ittp";
    }

    try {
      await BackgroundRunner.dispatchEvent({
        label: BACKGROUND_RUNNER_LABEL,
        event: "configure",
        details,
      });
    } catch (error) {
      console.warn(
        `${ctx.logPrefix} Background runner unavailable:`,
        error instanceof Error ? error.message : error,
      );
    }

    if (
      ctx.isAndroid &&
      runtimeConfig.mode === "local" &&
      !authToken &&
      retry < 2
    ) {
      window.setTimeout(
        () => void configureBackgroundRunner(retry + 1),
        BACKGROUND_RUNNER_CONFIG_RETRY_MS * (retry + 1),
      );
    }
  }

  async function initializeDeviceBridge(): Promise<void> {
    const runtimeConfig = ctx.getIosRuntimeConfig();
    if (
      !ctx.isNative ||
      (runtimeConfig.mode !== "cloud-hybrid" && runtimeConfig.mode !== "local")
    ) {
      return;
    }
    if (deviceBridgeClient) return;
    if (deviceBridgeStartPromise) return;

    const agentUrl = resolveDeviceBridgeUrl(runtimeConfig);
    if (!agentUrl) return;

    deviceBridgeStartPromise = (async () => {
      try {
        const [{ startDeviceBridgeClient }, deviceId] = await Promise.all([
          import("@elizaos/capacitor-llama"),
          getOrCreateDeviceBridgeId(),
        ]);
        const pairingToken =
          runtimeConfig.deviceBridgeToken?.trim() ||
          (ctx.isAndroid && runtimeConfig.mode === "local"
            ? await readAndroidLocalAgentToken()
            : undefined);
        if (ctx.isAndroid && runtimeConfig.mode === "local" && !pairingToken) {
          window.setTimeout(
            () => void initializeDeviceBridge(),
            BACKGROUND_RUNNER_CONFIG_RETRY_MS,
          );
          return;
        }
        deviceBridgeClient = startDeviceBridgeClient({
          agentUrl,
          ...(pairingToken ? { pairingToken } : {}),
          deviceId,
          onStateChange: (state, detail) => {
            console.info(
              `${ctx.logPrefix} Device bridge ${state}`,
              detail ?? "",
            );
          },
        });
      } catch (error) {
        console.warn(
          `${ctx.logPrefix} Device bridge unavailable:`,
          error instanceof Error ? error.message : error,
        );
      } finally {
        deviceBridgeStartPromise = null;
      }
    })();

    await deviceBridgeStartPromise;
  }

  function stopDeviceBridge(): void {
    deviceBridgeClient?.stop();
    deviceBridgeClient = null;
  }

  async function initializeAgentTunnel(): Promise<void> {
    const runtimeConfig = ctx.getIosRuntimeConfig();
    if (!ctx.isNative || (!ctx.isIOS && !ctx.isAndroid)) return;
    if (runtimeConfig.mode !== "tunnel-to-mobile") return;
    if (agentTunnelStartPromise) return;
    const relayUrl = runtimeConfig.tunnelRelayUrl;
    if (!relayUrl) {
      console.warn(
        `${ctx.logPrefix} tunnel-to-mobile mode requires VITE_ELIZA_TUNNEL_RELAY_URL`,
      );
      return;
    }
    if (!ctx.trustPolicy.isTrustedNativeWebSocketUrl(relayUrl)) {
      console.warn(`${ctx.logPrefix} Rejected unsafe mobile tunnel relay URL`);
      return;
    }

    agentTunnelStartPromise = (async () => {
      try {
        const [{ MobileAgentBridge }, deviceId] = await Promise.all([
          import("@elizaos/capacitor-mobile-agent-bridge"),
          getOrCreateDeviceBridgeId(),
        ]);

        if (!agentTunnelListener) {
          agentTunnelListener = await MobileAgentBridge.addListener(
            "stateChange",
            (event) => {
              console.info(
                `${ctx.logPrefix} Mobile agent tunnel ${event.state}`,
                event.reason ?? "",
              );
            },
          );
        }

        const status = await MobileAgentBridge.startInboundTunnel({
          relayUrl,
          deviceId,
          ...(runtimeConfig.tunnelPairingToken
            ? { pairingToken: runtimeConfig.tunnelPairingToken }
            : {}),
          ...(ctx.isAndroid
            ? { localAgentApiBase: MOBILE_LOCAL_AGENT_API_BASE }
            : {}),
        });
        console.info(
          `${ctx.logPrefix} Mobile agent tunnel ${status.state}`,
          status.lastError ?? "",
        );
      } catch (error) {
        console.warn(
          `${ctx.logPrefix} Mobile agent tunnel unavailable:`,
          error instanceof Error ? error.message : error,
        );
      } finally {
        agentTunnelStartPromise = null;
      }
    })();

    await agentTunnelStartPromise;
  }

  async function stopAgentTunnel(): Promise<void> {
    agentTunnelStartPromise = null;
    try {
      const { MobileAgentBridge } = await import(
        "@elizaos/capacitor-mobile-agent-bridge"
      );
      await MobileAgentBridge.stopInboundTunnel();
    } catch (error) {
      console.warn(
        `${ctx.logPrefix} Mobile agent tunnel stop failed:`,
        error instanceof Error ? error.message : error,
      );
    }
    try {
      await agentTunnelListener?.remove();
    } catch {
      // Native tunnel stop above is authoritative.
    }
    agentTunnelListener = null;
  }

  function initializeRuntimeModeListener(eventName: string): void {
    if (!ctx.isNative || runtimeModeListenerInstalled) return;
    runtimeModeListenerInstalled = true;
    document.addEventListener(eventName, () => {
      const mode = ctx.getIosRuntimeConfig().mode;
      if (mode === "cloud-hybrid" || mode === "local") {
        stopDeviceBridge();
        void stopAgentTunnel();
        void initializeDeviceBridge();
        void configureBackgroundRunner();
        return;
      }
      if (mode === "tunnel-to-mobile") {
        stopDeviceBridge();
        void initializeAgentTunnel();
        void configureBackgroundRunner();
        return;
      }
      stopDeviceBridge();
      void stopAgentTunnel();
      void configureBackgroundRunner();
    });
  }

  return {
    configureBackgroundRunner,
    initializeDeviceBridge,
    initializeAgentTunnel,
    initializeRuntimeModeListener,
  };
}

export type MobileBridges = ReturnType<typeof createMobileBridges>;
