import { Capacitor } from "@capacitor/core";
import type { AgentUpdateAuthority, AgentUpdateStatus } from "@elizaos/shared";
import { type BuildVariant, getBuildVariant } from "../../build-variant";
import { isElizaOS } from "../../platform";

export type AppUpdatePlatform = "desktop" | "ios" | "android" | "web";
export type AppDistributionChannel =
  | "desktop-direct"
  | "desktop-store"
  | "ios-app-store"
  | "ios-sideload"
  | "android-google-play"
  | "android-sideload"
  | "android-aosp"
  | "web";
export type AppUpdateAuthority = "github" | "store" | "aosp-image" | "web";

export interface NativeAppInfo {
  name?: string;
  id?: string;
  version?: string;
  build?: string;
}

type CapacitorAppModule = {
  App: {
    getInfo: () => Promise<NativeAppInfo>;
  };
};

export interface AppUpdatePolicyInput {
  platform: AppUpdatePlatform;
  native: boolean;
  buildVariant: BuildVariant;
  elizaOS: boolean;
}

export interface AppUpdatePolicy {
  channel: AppDistributionChannel;
  authority: AppUpdateAuthority;
  canAutoUpdate: boolean;
  canManualCheck: boolean;
  canOpenReleaseNotes: boolean;
  statusLabel: string;
  detail: string;
  actionLabel: string | null;
}

export interface ApplicationUpdateSnapshot extends AppUpdatePolicy {
  appName: string;
  appId: string | null;
  version: string;
  build: string | null;
  platform: AppUpdatePlatform;
  buildVariant: BuildVariant;
}

export type AgentUpdateUiStatus = "current" | "update-available" | "error";

export interface ConnectedAgentUpdateSnapshot {
  authority: AgentUpdateAuthority;
  authorityLabel: string;
  installMethod: string;
  currentVersion: string;
  latestVersion: string | null;
  channel: AgentUpdateStatus["channel"];
  updateAvailable: boolean;
  lastCheckAt: string | null;
  error: string | null;
  status: AgentUpdateUiStatus;
  statusLabel: string;
  detail: string;
  canManualCheck: boolean;
  canAutoUpdate: boolean;
  actionLabel: string | null;
}

export function resolveAppUpdatePolicy(
  input: AppUpdatePolicyInput,
): AppUpdatePolicy {
  if (input.platform === "desktop") {
    if (input.buildVariant === "store") {
      return {
        channel: "desktop-store",
        authority: "store",
        canAutoUpdate: false,
        canManualCheck: false,
        canOpenReleaseNotes: true,
        statusLabel: "Managed by store",
        detail:
          "This build must receive application updates through its desktop store.",
        actionLabel: null,
      };
    }
    return {
      channel: "desktop-direct",
      authority: "github",
      canAutoUpdate: true,
      canManualCheck: true,
      canOpenReleaseNotes: true,
      statusLabel: "Automatic updates on",
      detail: "This direct desktop build checks GitHub-hosted releases.",
      actionLabel: "Check / Download Update",
    };
  }

  if (input.platform === "ios") {
    if (input.buildVariant === "store") {
      return {
        channel: "ios-app-store",
        authority: "store",
        canAutoUpdate: false,
        canManualCheck: false,
        canOpenReleaseNotes: true,
        statusLabel: "Managed by App Store",
        detail:
          "iOS App Store builds cannot download executable app updates outside the App Store.",
        actionLabel: null,
      };
    }
    return {
      channel: "ios-sideload",
      authority: "github",
      canAutoUpdate: false,
      canManualCheck: false,
      canOpenReleaseNotes: true,
      statusLabel: "Manual sideload updates",
      detail:
        "This iOS build can point to GitHub releases, but installing a new binary still goes through the sideloading toolchain.",
      actionLabel: null,
    };
  }

  if (input.platform === "android") {
    if (input.elizaOS) {
      return {
        channel: "android-aosp",
        authority: "aosp-image",
        canAutoUpdate: false,
        canManualCheck: false,
        canOpenReleaseNotes: true,
        statusLabel: "Managed by system image",
        detail:
          "AOSP system builds update with the device image or privileged package channel.",
        actionLabel: null,
      };
    }
    if (input.buildVariant === "store") {
      return {
        channel: "android-google-play",
        authority: "store",
        canAutoUpdate: false,
        canManualCheck: false,
        canOpenReleaseNotes: true,
        statusLabel: "Managed by Google Play",
        detail:
          "Google Play builds cannot self-update or download executable code outside Play.",
        actionLabel: null,
      };
    }
    return {
      channel: "android-sideload",
      authority: "github",
      canAutoUpdate: false,
      canManualCheck: false,
      canOpenReleaseNotes: true,
      statusLabel: "Manual APK updates",
      detail:
        "This sideload build can link to GitHub APK releases, but Android installation still requires user-controlled package install consent.",
      actionLabel: null,
    };
  }

  return {
    channel: "web",
    authority: "web",
    canAutoUpdate: false,
    canManualCheck: false,
    canOpenReleaseNotes: true,
    statusLabel: "Updated on reload",
    detail: "The hosted web app updates when the deployed site changes.",
    actionLabel: null,
  };
}

function resolveAgentAuthority(
  installMethod: string,
): Pick<
  ConnectedAgentUpdateSnapshot,
  "authority" | "authorityLabel" | "detail"
> {
  switch (installMethod) {
    case "npm-global":
      return {
        authority: "npm",
        authorityLabel: "npm global",
        detail:
          "The connected agent is updated with npm on the host running the agent.",
      };
    case "bun-global":
      return {
        authority: "bun",
        authorityLabel: "Bun global",
        detail:
          "The connected agent is updated with Bun on the host running the agent.",
      };
    case "homebrew":
      return {
        authority: "homebrew",
        authorityLabel: "Homebrew",
        detail:
          "The connected agent is managed by Homebrew on the host running the agent.",
      };
    case "snap":
      return {
        authority: "snap",
        authorityLabel: "Snap",
        detail:
          "The connected agent is managed by Snap on the host running the agent.",
      };
    case "apt":
      return {
        authority: "apt",
        authorityLabel: "Debian apt",
        detail:
          "The connected agent is managed by the Debian package manager on the host.",
      };
    case "flatpak":
      return {
        authority: "flatpak",
        authorityLabel: "Flatpak",
        detail:
          "The connected agent is managed by Flatpak on the host running the agent.",
      };
    case "local-dev":
      return {
        authority: "local-dev",
        authorityLabel: "Local development checkout",
        detail:
          "The connected agent is a local development checkout and should be updated with workspace tooling.",
      };
    default:
      return {
        authority: "unknown",
        authorityLabel: "Agent host",
        detail:
          "The connected agent reports update metadata, but its install authority is not known to the app.",
      };
  }
}

export function mapAgentUpdateStatusToSnapshot(
  status: AgentUpdateStatus | null | undefined,
): ConnectedAgentUpdateSnapshot | null {
  if (!status) return null;

  const authority = resolveAgentAuthority(status.installMethod);
  const uiStatus: AgentUpdateUiStatus = status.error
    ? "error"
    : status.updateAvailable
      ? "update-available"
      : "current";

  return {
    ...authority,
    installMethod: status.installMethod,
    currentVersion: status.currentVersion,
    latestVersion: status.latestVersion,
    channel: status.channel,
    updateAvailable: status.updateAvailable,
    lastCheckAt: status.lastCheckAt,
    error: status.error,
    status: uiStatus,
    statusLabel:
      uiStatus === "error"
        ? "Check failed"
        : uiStatus === "update-available"
          ? "Update available"
          : "Current",
    detail: status.updateInstructions ?? authority.detail,
    canManualCheck: true,
    canAutoUpdate: status.canAutoUpdate ?? false,
    actionLabel: null,
  };
}

export async function readNativeAppInfo(): Promise<NativeAppInfo | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const capacitorAppPackage = "@capacitor/app";
    const mod = (await import(
      /* @vite-ignore */ capacitorAppPackage
    )) as CapacitorAppModule;
    return await mod.App.getInfo();
  } catch {
    return null;
  }
}

function currentPlatform(): AppUpdatePlatform {
  const platform = Capacitor.getPlatform();
  if (platform === "ios" || platform === "android") return platform;
  return "web";
}

export async function getApplicationUpdateSnapshot(options?: {
  desktop?: boolean;
  appName?: string;
  appId?: string | null;
  version?: string | null;
  build?: string | null;
}): Promise<ApplicationUpdateSnapshot> {
  const nativeInfo = await readNativeAppInfo();
  const platform = options?.desktop ? "desktop" : currentPlatform();
  const buildVariant = getBuildVariant();
  const policy = resolveAppUpdatePolicy({
    platform,
    native: Capacitor.isNativePlatform(),
    buildVariant,
    elizaOS: isElizaOS(),
  });

  return {
    ...policy,
    appName: options?.appName ?? nativeInfo?.name ?? "Eliza",
    appId: options?.appId ?? nativeInfo?.id ?? null,
    version: options?.version ?? nativeInfo?.version ?? "unknown",
    build: options?.build ?? nativeInfo?.build ?? null,
    platform,
    buildVariant,
  };
}
