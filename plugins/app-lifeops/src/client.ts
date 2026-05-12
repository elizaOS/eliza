// Side-effect: register LifeOps methods on ElizaClient.
import "./api/client-lifeops.js";
// `ElizaClient` comes from the UI barrel so the client extension augments the
// same class instance used by the frontend shell.
import { ElizaClient } from "@elizaos/ui";
import {
  type AppBlockerPermissionResult,
  type AppBlockerPluginLike,
  type AppBlockerStatus,
  type BlockAppsOptions,
  type BlockAppsResult,
  type InstalledApp,
  type SelectAppsResult,
  type UnblockAppsResult,
} from "./app-blocker/types.js";
import {
  getAppBlockerPlugin,
} from "@elizaos/ui";

function requireAppBlockerPlugin(): AppBlockerPluginLike {
  const plugin = getAppBlockerPlugin();
  if (
    typeof plugin.checkPermissions !== "function" ||
    typeof plugin.requestPermissions !== "function" ||
    typeof plugin.getStatus !== "function" ||
    typeof plugin.getInstalledApps !== "function" ||
    typeof plugin.selectApps !== "function" ||
    typeof plugin.blockApps !== "function" ||
    typeof plugin.unblockApps !== "function"
  ) {
    throw new Error("App blocker is not available on this platform.");
  }
  return plugin;
}

declare module "@elizaos/ui" {
  interface ElizaClient {
    checkAppBlockerPermissions(): Promise<AppBlockerPermissionResult>;
    requestAppBlockerPermissions(): Promise<AppBlockerPermissionResult>;
    getAppBlockerStatus(): Promise<AppBlockerStatus>;
    getInstalledAppsToBlock(): Promise<{ apps: InstalledApp[] }>;
    selectAppBlockerApps(): Promise<SelectAppsResult>;
    startAppBlock(options: BlockAppsOptions): Promise<BlockAppsResult>;
    stopAppBlock(): Promise<UnblockAppsResult>;
  }
}

ElizaClient.prototype.checkAppBlockerPermissions = async () =>
  requireAppBlockerPlugin().checkPermissions();

ElizaClient.prototype.requestAppBlockerPermissions = async () =>
  requireAppBlockerPlugin().requestPermissions();

ElizaClient.prototype.getAppBlockerStatus = async () =>
  requireAppBlockerPlugin().getStatus();

ElizaClient.prototype.getInstalledAppsToBlock = async () =>
  requireAppBlockerPlugin().getInstalledApps();

ElizaClient.prototype.selectAppBlockerApps = async () =>
  requireAppBlockerPlugin().selectApps();

ElizaClient.prototype.startAppBlock = async (options: BlockAppsOptions) =>
  requireAppBlockerPlugin().blockApps(options);

ElizaClient.prototype.stopAppBlock = async () =>
  requireAppBlockerPlugin().unblockApps();
