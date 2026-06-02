import { describe, expect, it } from "bun:test";
import * as manifestBarrel from "./index.js";

describe("remote plugin package barrel", () => {
  it("exports the expected runtime public surface", () => {
    expect(Object.keys(manifestBarrel).sort()).toEqual([
      "BUN_PERMISSIONS",
      "HOST_PERMISSIONS",
      "PLUGIN_MANIFEST_KEY",
      "PluginSignatureError",
      "REMOTE_PLUGIN_ISOLATIONS",
      "RemotePluginStoreError",
      "assertRemotePluginPayload",
      "buildRemotePluginPermissionConsentRequest",
      "buildRemotePluginRuntimeContext",
      "canonicalRpcBytes",
      "diffRemotePluginPermissions",
      "ensureRemotePluginSourceDirectory",
      "flattenRemotePluginPermissions",
      "getRemotePluginManifestPermissionTags",
      "getRemotePluginStorePaths",
      "hasBunPermission",
      "hasHostPermission",
      "hexDecode",
      "hexEncode",
      "installPrebuiltRemotePlugin",
      "isRemotePluginPermissionTag",
      "isRemotePluginSourceDirectory",
      "listInstalledRemotePluginDirectories",
      "loadInstalledRemotePlugin",
      "loadInstalledRemotePlugins",
      "loadRemotePluginListEntries",
      "loadRemotePluginStoreSnapshot",
      "mergeRemotePluginPermissions",
      "normalizeRemotePluginPermissions",
      "parseRemotePluginPermissionTag",
      "pluginRpcKeyId",
      "readRemotePluginInstallRecord",
      "readRemotePluginManifestAt",
      "readRemotePluginRegistry",
      "resolveRemotePluginPathInside",
      "sha256File",
      "syncRemotePluginRegistry",
      "toBunWorkerPermissions",
      "toInstalledRemotePluginSnapshot",
      "toRemotePluginListEntry",
      "toRemotePluginViewUrl",
      "uninstallInstalledRemotePlugin",
      "validateRemotePluginManifest",
      "verifyPluginArtifact",
      "writeRemotePluginInstallRecord",
      "writeRemotePluginRegistry",
      "writeRemotePluginWorkerBootstrap",
    ]);

    expect(typeof manifestBarrel.RemotePluginStoreError).toBe("function");
    expect(typeof manifestBarrel.PluginSignatureError).toBe("function");
    expect(manifestBarrel.BUN_PERMISSIONS).toContain("env");
    expect(manifestBarrel.HOST_PERMISSIONS).toContain("manage-remote-plugins");
    expect(manifestBarrel.REMOTE_PLUGIN_ISOLATIONS).toContain(
      "isolated-process",
    );
  });
});
