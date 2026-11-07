// Side-effect: register LifeOps methods on ElizaClient.
import "./api/client-lifeops.js";
import type {
  AppBlockerPermissionResult,
  AppBlockerPluginLike,
  AppBlockerStatus,
  BlockAppsOptions,
  BlockAppsResult,
  InstalledApp,
  SelectAppsResult,
  UnblockAppsResult,
} from "@elizaos/plugin-blocker/services/app-blocker/index";
// `ElizaClient` comes from the UI barrel so the client extension augments the
// same class instance used by the frontend shell.
import { client, ElizaClient, getAppBlockerPlugin } from "@elizaos/ui";

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

export interface AppBlockerClientMethods {
  checkAppBlockerPermissions(): Promise<AppBlockerPermissionResult>;
  requestAppBlockerPermissions(): Promise<AppBlockerPermissionResult>;
  getAppBlockerStatus(): Promise<AppBlockerStatus>;
  getInstalledAppsToBlock(): Promise<{ apps: InstalledApp[] }>;
  selectAppBlockerApps(): Promise<SelectAppsResult>;
  startAppBlock(options: BlockAppsOptions): Promise<BlockAppsResult>;
  stopAppBlock(): Promise<UnblockAppsResult>;
}

export const appBlockerClient = client as ElizaClient & AppBlockerClientMethods;
const appBlockerPrototype = ElizaClient.prototype as ElizaClient &
  AppBlockerClientMethods;

appBlockerPrototype.checkAppBlockerPermissions = async () =>
  requireAppBlockerPlugin().checkPermissions();

appBlockerPrototype.requestAppBlockerPermissions = async () =>
  requireAppBlockerPlugin().requestPermissions();

appBlockerPrototype.getAppBlockerStatus = async () =>
  requireAppBlockerPlugin().getStatus();

appBlockerPrototype.getInstalledAppsToBlock = async () =>
  requireAppBlockerPlugin().getInstalledApps();

appBlockerPrototype.selectAppBlockerApps = async () =>
  requireAppBlockerPlugin().selectApps();

appBlockerPrototype.startAppBlock = async (options: BlockAppsOptions) =>
  requireAppBlockerPlugin().blockApps(options);

appBlockerPrototype.stopAppBlock = async () =>
  requireAppBlockerPlugin().unblockApps();
