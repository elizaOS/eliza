// Side-effect: register LifeOps methods on ElizaClient.
import "./api/client-lifeops.js";
// `ElizaClient` MUST come from `@elizaos/app-core/api/client-base` (the
// source module) — the `@elizaos/app-core` barrel imports this file as a
// side-effect and would resolve to `undefined` here at module-init time.
import { ElizaClient } from "@elizaos/app-core";
import {
  type AppBlockerPermissionResult,
  type AppBlockerPluginLike,
  type AppBlockerStatus,
  type BlockAppsOptions,
  type BlockAppsResult,
  getAppBlockerPlugin,
  type InstalledApp,
  type SelectAppsResult,
  type UnblockAppsResult,
} from "@elizaos/app-core";

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

declare module "@elizaos/app-core/api/client-base" {
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
