import { Capacitor } from "@capacitor/core";
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

export async function readNativeAppInfo(): Promise<NativeAppInfo | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const mod = (await import(
      /* @vite-ignore */ "@capacitor/app"
    )) as typeof import("@capacitor/app");
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
