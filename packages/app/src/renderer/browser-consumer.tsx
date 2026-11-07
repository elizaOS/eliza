/** The canonical mobile application for branded browser hosts; never mounts a root. */
import type {
  RuntimeManagementRequest,
  RuntimeManagementResult,
} from "@elizaos/contracts/runtime-management";
import { ShellModalityProvider, ShellRoleProvider } from "@elizaos/ui";
import { AppProvider } from "@elizaos/ui/app/AppProvider";
import type { NativeCloudSessionPort } from "@elizaos/ui/app/native-cloud-session";
import type { ReactElement, ReactNode } from "react";
import {
  type AndroidLocalAgentBootState,
  getAndroidLocalAgentBootStateForUrl,
  requestAndroidLocalAgentStartForUrl,
} from "../../../ui/src/api/android-native-agent-transport.js";
import {
  configureHostAgentCapabilities,
  configureHostTransport,
  type HostAgentCapabilities,
  type HostTransportSelector,
} from "../../../ui/src/api/host-transport.js";
import {
  type AppRuntimeSessionState,
  useAppRuntimeSession,
} from "../../../ui/src/app/runtime-session.js";
import { initializeCapacitorBridge } from "../../../ui/src/bridge/capacitor-bridge.js";
import { initializeStorageBridge } from "../../../ui/src/bridge/storage-bridge.js";
import {
  getBootConfig,
  setBootConfig,
} from "../../../ui/src/config/boot-config-store.js";
import type { BrandingConfig } from "../../../ui/src/config/branding-base.js";
import { createBrowserStartupHost } from "../../../ui/src/startup/browser-host.js";
import type { StartupHostPorts } from "../../../ui/src/startup/startup-host-ports.js";
import { useApp } from "../../../ui/src/state/useApp.js";
import {
  appendIosBootTrace,
  isIosInProcessLocalAgentBase,
  isIosNativeAgentBootInProgress,
  isTerminalIosNativeAgentBootErrorMessage,
} from "./transports/ios-local-agent-transport";
import "@elizaos/ui/styles";
import {
  NativePermissionHostProvider,
  type PermissionPrimingHost,
} from "../../../ui/src/components/permissions/native-permission-host";
import { App } from "./App";

export * from "../../../ui/src/app/browser-consumer.js";
export type { PermissionPrimingHost } from "../../../ui/src/components/permissions/native-permission-host";
export {
  adoptWalkthroughProgress,
  locationAccess,
  permissionStateAccess,
  photoLibraryAccess,
  walkthroughMemory,
  walkthroughProgress,
} from "../../../ui/src/components/permissions/native-permission-host";

export interface BrowserConsumerHostOptions {
  branding?: Partial<BrandingConfig>;
  apiBase?: string;
  cloudApiBase?: string;
  nativeCloudSession?: NativeCloudSessionPort;
  transport?: HostTransportSelector;
  agentCapabilities?: HostAgentCapabilities;
  permissions?: PermissionPrimingHost;
  prepareNativeRuntimeForUrl?: (
    base: string,
    signal: AbortSignal,
  ) => Promise<void>;
  requestAndroidLocalAgentStartForUrl?: (
    base: string | null | undefined,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  getAndroidLocalAgentBootStateForUrl?: (
    base: string | null | undefined,
  ) => Promise<AndroidLocalAgentBootState>;
  executeRuntimeManagementCommand?: (
    request: RuntimeManagementRequest,
  ) => Promise<RuntimeManagementResult>;
}
/** Holds host configuration. Startup state and transitions remain in the shared provider. */
export class BrowserConsumerHost {
  #ports: StartupHostPorts;
  #options: BrowserConsumerHostOptions;
  constructor(options: BrowserConsumerHostOptions = {}) {
    this.#options = options;
    this.#ports = createBrowserStartupHost({
      native: {
        ...(options.prepareNativeRuntimeForUrl
          ? { prepareNativeRuntimeForUrl: options.prepareNativeRuntimeForUrl }
          : {}),
        requestAndroidLocalAgentStartForUrl:
          options.requestAndroidLocalAgentStartForUrl ??
          requestAndroidLocalAgentStartForUrl,
        getAndroidLocalAgentBootStateForUrl:
          options.getAndroidLocalAgentBootStateForUrl ??
          getAndroidLocalAgentBootStateForUrl,
        appendIosBootTrace,
        isIosInProcessLocalAgentBase,
        isIosNativeAgentBootInProgress,
        isTerminalIosNativeAgentBootErrorMessage,
      },
      executeRuntimeManagementCommand:
        options.executeRuntimeManagementCommand ??
        (async (request) =>
          (
            await import("./runtime-management")
          ).executeRuntimeManagementCommand(request)),
    });
  }
  /** Configure the actual shared transports, then hydrate storage before native bridge publication. */
  async initialize(): Promise<void> {
    await import("./transports/configure");
    if (this.#options.transport)
      configureHostTransport(this.#options.transport);
    if (this.#options.agentCapabilities)
      configureHostAgentCapabilities(this.#options.agentCapabilities);
    setBootConfig({
      ...getBootConfig(),
      ...(this.#options.apiBase ? { apiBase: this.#options.apiBase } : {}),
      ...(this.#options.cloudApiBase
        ? { cloudApiBase: this.#options.cloudApiBase }
        : {}),
      branding: this.#options.branding ?? {},
    });
    await initializeStorageBridge();
    initializeCapacitorBridge();
  }
  /** Render only; this neither mounts a root nor owns a second startup coordinator. */
  render(children?: ReactNode): ReactElement {
    return (
      <AppProvider
        startupHost={this.#ports}
        nativeCloudSession={this.#options.nativeCloudSession}
        branding={this.#options.branding}
      >
        <NativePermissionHostProvider host={this.#options.permissions}>
          <ShellModalityProvider modality="gui">
            <ShellRoleProvider>
              <App />
              {children}
            </ShellRoleProvider>
          </ShellModalityProvider>
        </NativePermissionHostProvider>
      </AppProvider>
    );
  }
}
export function createBrowserConsumerHost(
  options: BrowserConsumerHostOptions = {},
): BrowserConsumerHost {
  return new BrowserConsumerHost(options);
}
export async function initializeBrowserConsumer(
  host: BrowserConsumerHost,
): Promise<void> {
  await host.initialize();
}
export function BrowserConsumerApp({
  host,
  children,
}: {
  host: BrowserConsumerHost;
  children?: ReactNode;
}): ReactElement {
  return host.render(children);
}
export interface BrowserRuntimeObservation {
  readonly startupPhase: string;
  readonly runtime: AppRuntimeSessionState;
  readonly retry: () => void;
}
/** Observe or retry the same provider; never starts another service or establishes identity. */
export function useBrowserRuntime(): BrowserRuntimeObservation {
  const app = useApp();
  return {
    startupPhase: app.startupCoordinator.phase,
    runtime: useAppRuntimeSession(),
    retry: app.retryStartup,
  };
}
