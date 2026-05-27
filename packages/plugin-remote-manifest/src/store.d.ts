import type {
  RemotePluginInstallRecord,
  RemotePluginInstallSource,
  RemotePluginListEntry,
  RemotePluginManifest,
  RemotePluginPermissionGrant,
  RemotePluginRegistry,
  RemotePluginRuntimeContext,
} from "./types.js";
export interface InstalledRemotePlugin {
  install: RemotePluginInstallRecord;
  manifest: RemotePluginManifest;
  rootDir: string;
  currentDir: string;
  stateDir: string;
  extractionDir: string;
  installPath: string;
  bundleWorkerPath: string;
  workerPath: string;
  viewPath: string;
  viewUrl: string;
}
export interface InstalledRemotePluginSnapshot {
  id: string;
  name: string;
  version: string;
  description: string;
  mode: RemotePluginManifest["mode"];
  status: RemotePluginInstallRecord["status"];
  sourceKind: RemotePluginInstallSource["kind"];
  currentHash: string | null;
  installedAt: number;
  updatedAt: number;
  devMode: boolean;
  lastBuildAt: number | null;
  lastBuildError: string | null;
  requestedPermissions: RemotePluginManifest["permissions"];
  grantedPermissions: RemotePluginPermissionGrant;
  view: RemotePluginManifest["view"] & {
    viewUrl: string;
  };
  worker: RemotePluginManifest["worker"];
  remoteUIs?: RemotePluginManifest["remoteUIs"];
}
export interface RemotePluginStoreSnapshot {
  version: 1;
  remotePlugins: InstalledRemotePluginSnapshot[];
}
export interface RemotePluginStorePaths {
  rootDir: string;
  currentDir: string;
  stateDir: string;
  extractionDir: string;
  installPath: string;
}
export interface InstallPrebuiltRemotePluginOptions {
  permissionsGranted?: RemotePluginPermissionGrant;
  source?: RemotePluginInstallSource;
  currentHash?: string | null;
  devMode?: boolean;
  lastBuildAt?: number | null;
  now?: () => number;
}
/**
 * SOC2 A-1: callers fetching an artifact source MUST invoke
 * `verifyPluginArtifact` BEFORE calling `installPrebuiltRemotePlugin`.
 * The store layer is kept sync + KMS-free; verification belongs in the
 * caller (agent download / install orchestrator) where the audit
 * dispatcher and KMS client already exist.
 */
export declare class RemotePluginStoreError extends Error {
  constructor(message: string);
}
export declare function getRemotePluginStorePaths(
  storeRoot: string,
  id: string,
): RemotePluginStorePaths;
export declare function resolveRemotePluginPathInside(
  rootDir: string,
  relativePath: string,
): string;
export declare function toRemotePluginViewUrl(relativePath: string): string;
export declare function readRemotePluginManifestAt(
  manifestPath: string,
): RemotePluginManifest;
export declare function assertRemotePluginPayload(
  payloadDir: string,
): RemotePluginManifest;
export declare function readRemotePluginRegistry(
  storeRoot: string,
): RemotePluginRegistry;
export declare function writeRemotePluginRegistry(
  storeRoot: string,
  registry: RemotePluginRegistry,
): RemotePluginRegistry;
export declare function listInstalledRemotePluginDirectories(
  storeRoot: string,
): string[];
export declare function readRemotePluginInstallRecord(
  storeRoot: string,
  id: string,
): RemotePluginInstallRecord | null;
export declare function writeRemotePluginInstallRecord(
  storeRoot: string,
  record: RemotePluginInstallRecord,
): RemotePluginInstallRecord;
export declare function buildRemotePluginRuntimeContext(
  currentDir: string,
  stateDir: string,
  remotePluginId: string,
  permissionsGranted: RemotePluginPermissionGrant,
  authToken?: string | null,
): RemotePluginRuntimeContext;
export declare function writeRemotePluginWorkerBootstrap(
  currentDir: string,
  manifest: RemotePluginManifest,
  install: RemotePluginInstallRecord,
  bundleWorkerPath: string,
  stateDir: string,
): string;
export declare function loadInstalledRemotePlugin(
  storeRoot: string,
  id: string,
): InstalledRemotePlugin | null;
export declare function syncRemotePluginRegistry(
  storeRoot: string,
): RemotePluginRegistry;
export declare function loadInstalledRemotePlugins(
  storeRoot: string,
): InstalledRemotePlugin[];
export declare function toInstalledRemotePluginSnapshot(
  remotePlugin: InstalledRemotePlugin,
): InstalledRemotePluginSnapshot;
export declare function toRemotePluginListEntry(
  remotePlugin: InstalledRemotePlugin,
): RemotePluginListEntry;
export declare function loadRemotePluginStoreSnapshot(
  storeRoot: string,
): RemotePluginStoreSnapshot;
export declare function loadRemotePluginListEntries(
  storeRoot: string,
): RemotePluginListEntry[];
export declare function installPrebuiltRemotePlugin(
  storeRoot: string,
  payloadDir: string,
  options?: InstallPrebuiltRemotePluginOptions,
): InstalledRemotePlugin;
export declare function uninstallInstalledRemotePlugin(
  storeRoot: string,
  id: string,
): RemotePluginInstallRecord | null;
export declare function isRemotePluginSourceDirectory(
  directory: string,
): boolean;
export declare function ensureRemotePluginSourceDirectory(
  directory: string,
): string;
//# sourceMappingURL=store.d.ts.map
