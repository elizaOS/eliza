/** Composes native-client browser control without desktop engines or server-side browser profiles. */
import {
  type Action,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  promoteSubactionsToActions,
  Service,
} from "@elizaos/core";
import type { HttpPlugin } from "@elizaos/core/api/http-plugin";
import { resolveAliasedEnvValue } from "@elizaos/core/config/boot-config-store";
import { asRecord } from "@elizaos/core/type-guards";
import { readViewInteractionClientId } from "@elizaos/core/views/view-interact-protocol";
import {
  browserDomainPolicyRequestForCommand,
  evaluateBrowserDomainPolicies,
} from "./browser-domain-policy.js";
import {
  BrowserDispatchFailure,
  isBrowserDispatchFailure,
  isIdempotentBrowserSubaction,
} from "./dispatch-types.js";
import {
  type NativeBrowserClientTransport,
  readNativeBrowserPage,
} from "./native-page-reader.js";
import { NativeSocketBrowserTarget } from "./native-socket-target.js";
import {
  nativeDeviceBrowserProfileRoutes,
  nativeDeviceBrowserRoute,
  nativeDeviceBrowserStatusRoute,
} from "./routes/native-device.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "./workspace/browser-workspace-types.js";

export { BrowserDispatchFailure } from "./dispatch-types.js";
export { decodeNativeBrowserCommandResult } from "./native-page-reader.js";

const commands = [
  "open",
  "navigate",
  "show",
  "snapshot",
  "get",
  "click",
  "fill",
  "scroll",
  "back",
  "list",
  "close",
  "forward",
  "reload",
] as const;

export class BrowserService extends Service {
  static override readonly serviceType = "browser";
  override capabilityDescription =
    "Controls only the authenticated requesting client's native browser.";
  private transport: NativeBrowserClientTransport | null = null;
  private nativeTarget: NativeSocketBrowserTarget | null = null;
  static override async start(runtime: IAgentRuntime): Promise<BrowserService> {
    const service = new BrowserService(runtime);
    if (
      [
        resolveAliasedEnvValue("ELIZA_PLATFORM"),
        process.env.ELIZA_MOBILE_PLATFORM,
      ].includes("android")
    ) {
      service.nativeTarget = new NativeSocketBrowserTarget((error) => {
        if (isBrowserDispatchFailure(error) && error.kind === "UNAVAILABLE")
          logger.info(
            "[browser] Native Chromium is unavailable; waiting for its connection.",
          );
        else runtime.reportError("browser.native-transport", error);
      });
      await service.nativeTarget.start();
    }
    return service;
  }
  setNativeClientTransport(
    transport: NativeBrowserClientTransport | null,
  ): void {
    this.transport = transport;
  }
  async executeNativeDeviceCommand(
    command: BrowserWorkspaceCommand,
    profileId: string,
  ): Promise<BrowserWorkspaceCommandResult> {
    if (!this.nativeTarget || this.nativeTarget.getProfileId() !== profileId)
      throw new BrowserDispatchFailure(
        "POLICY_BLOCKED",
        "The authorized Chromium profile is not connected to this device.",
      );
    return this.execute(command, "chromium-device");
  }
  getNativeDeviceStatus():
    | { connected: false }
    | { connected: true; profileId: string; targetId: string } {
    const profileId = this.nativeTarget?.getProfileId();
    return profileId
      ? { connected: true, profileId, targetId: "chromium-device" }
      : { connected: false };
  }
  async stop(): Promise<void> {
    await this.nativeTarget?.stop();
    this.transport = null;
  }
  async execute(
    command: BrowserWorkspaceCommand,
    targetId?: string,
    clientId?: string,
  ): Promise<BrowserWorkspaceCommandResult> {
    if (
      (!targetId || targetId === "chromium-device") &&
      this.nativeTarget &&
      (await this.nativeTarget.available())
    ) {
      const decision = evaluateBrowserDomainPolicies(
        browserDomainPolicyRequestForCommand(command, "chromium-device"),
      );
      if (decision.verdict !== "allow")
        throw new BrowserDispatchFailure("POLICY_BLOCKED", decision.reason);
      return this.nativeTarget.execute(command);
    }
    if (!clientId || !this.transport)
      throw new BrowserDispatchFailure(
        "UNAVAILABLE",
        "Connect the requesting native browser client.",
        { targetId: "native-client" },
      );
    if (targetId && targetId !== "workspace" && targetId !== "native-client")
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This device controls only its native browser.",
      );
    if (!commands.some((value) => value === command.subaction) || command.id)
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "Use a supported native command without a server tab ID.",
      );
    const decision = evaluateBrowserDomainPolicies(
      browserDomainPolicyRequestForCommand(command, "native-client"),
    );
    if (decision.verdict !== "allow")
      throw new BrowserDispatchFailure("POLICY_BLOCKED", decision.reason, {
        targetId: "native-client",
      });
    let url: string | undefined;
    if (["open", "navigate", "show"].includes(command.subaction)) {
      if (command.url) {
        const parsed = new URL(command.url);
        if (
          !["https:", "http:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password
        )
          throw new BrowserDispatchFailure(
            "POLICY_BLOCKED",
            "Native navigation requires an HTTP(S) URL without embedded credentials.",
          );
        url = parsed.href;
      } else if (command.subaction !== "show")
        throw new BrowserDispatchFailure(
          "UNSUPPORTED",
          "Navigation requires a URL.",
        );
    }
    try {
      if (["open", "navigate", "show"].includes(command.subaction)) {
        await this.transport.navigate(clientId, url);
        return {
          targetId: "native-client",
          mode: "web",
          subaction: command.subaction,
          value: { dispatched: true, completed: false, requiresReadback: true },
        };
      }
      if (command.subaction === "get")
        return await readNativeBrowserPage(
          command,
          clientId,
          this.transport.readPage,
        );
      if (!this.transport.executeCommand)
        throw new BrowserDispatchFailure(
          "UNAVAILABLE",
          "Native control transport is unavailable.",
        );
      return await this.transport.executeCommand(clientId, command);
    } catch (error) {
      // error-policy:J2 uncertain native effects must never be replayed in another browser.
      if (
        isBrowserDispatchFailure(error) ||
        isIdempotentBrowserSubaction(command.subaction)
      )
        throw error;
      throw new BrowserDispatchFailure(
        "UNCERTAIN_OUTCOME",
        "The browser command may have executed; read the same browser before retrying.",
        { targetId: "native-client", cause: error },
      );
    }
  }
}

export const browserAction: Action = {
  name: "BROWSER",
  description:
    "Control the requesting device's native Chromium browser. Use snapshot to inspect accessibility elements. Pass the exact latest snapshot selector to click, fill, scroll or back. Each effect invalidates selectors and requires a new snapshot; accepted dispatch does not prove website completion.",
  similes: [],
  examples: [],
  validate: async (runtime) => runtime.getService("browser") !== null,
  parameters: [
    {
      name: "id",
      required: false,
      description: "Exact Chromium tab ID returned by list",
      schema: { type: "string" },
    },
    {
      name: "action",
      required: true,
      description: "Native browser command",
      schema: { type: "string", enum: [...commands] },
    },
    {
      name: "url",
      required: false,
      description: "HTTP(S) navigation URL",
      schema: { type: "string" },
    },
    {
      name: "selector",
      required: false,
      description: "Exact element selector from the latest native snapshot",
      schema: { type: "string" },
    },
    {
      name: "text",
      required: false,
      description: "Replacement text for fill",
      schema: { type: "string" },
    },
    {
      name: "direction",
      required: false,
      description: "Scroll direction",
      schema: { type: "string", enum: ["up", "down", "left", "right"] },
    },
  ],
  handler: async (runtime, message, _state, options) => {
    const params = asRecord(
      (options as HandlerOptions | undefined)?.parameters,
    );
    const action = commands.find((value) => value === params?.action);
    if (!action)
      return {
        success: false,
        text: "A supported native browser action is required.",
      };
    const clientId = readViewInteractionClientId(message);
    const service = runtime.getService<BrowserService>("browser");
    if (!service)
      return {
        success: false,
        text: "The requesting native browser client is unavailable.",
      };
    const command: BrowserWorkspaceCommand = { subaction: action };
    for (const key of ["url", "selector", "text", "id"] as const) {
      const value = params?.[key];
      if (value !== undefined && typeof value !== "string")
        return { success: false, text: `${key} must be a string.` };
      if (typeof value === "string") command[key] = value;
    }
    if (params?.direction !== undefined) {
      const direction = params.direction;
      if (
        direction !== "up" &&
        direction !== "down" &&
        direction !== "left" &&
        direction !== "right"
      )
        return { success: false, text: "Invalid scroll direction." };
      command.direction = direction;
    }
    try {
      const result = await service.execute(command, undefined, clientId);
      return {
        success: true,
        text: JSON.stringify(result),
        data: { actionName: "BROWSER", result },
      };
    } catch (error) {
      // error-policy:J1 action boundary exposes native failure without fabricated success.
      return {
        success: false,
        text: error instanceof Error ? error.message : String(error),
        data: {
          actionName: "BROWSER",
          ...(isBrowserDispatchFailure(error)
            ? {
                dispatchFailure: {
                  kind: error.kind,
                  fallbackSafe: error.fallbackSafe,
                  targetId: error.targetId,
                },
              }
            : {}),
        },
      };
    }
  },
};

export const browserPlugin: HttpPlugin = {
  name: "@elizaos/plugin-browser",
  description: "Authenticated native device browser control",
  services: [BrowserService],
  routes: [
    nativeDeviceBrowserRoute,
    nativeDeviceBrowserStatusRoute,
    ...nativeDeviceBrowserProfileRoutes,
  ],
  actions: [...promoteSubactionsToActions(browserAction)],
};
export default browserPlugin;

/** Desktop connector profiles cannot be substituted with a phone's personal Chromium profile. */
function desktopConnectorUnavailable(): never {
  throw new BrowserDispatchFailure(
    "UNSUPPORTED",
    "Desktop connector-profile automation is unavailable on this device. Use native browser commands against an explicitly authorized device session.",
  );
}
export const closeBrowserWorkspaceTab = desktopConnectorUnavailable;
export const evaluateBrowserWorkspaceTab = desktopConnectorUnavailable;
export const listBrowserWorkspaceTabs = desktopConnectorUnavailable;
export const navigateBrowserWorkspaceTab = desktopConnectorUnavailable;
export const openBrowserWorkspaceTab = desktopConnectorUnavailable;
export const resolveBrowserWorkspaceConnectorPartition =
  desktopConnectorUnavailable;
export const showBrowserWorkspaceTab = desktopConnectorUnavailable;
export function isBrowserWorkspaceBridgeConfigured(): boolean {
  return false;
}
