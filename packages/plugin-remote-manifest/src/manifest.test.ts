/**
 * Manifest helper tests cover permission consent requests, manifest tag
 * extraction, and permission diffs for remote plugin install review.
 */
import { describe, expect, it } from "bun:test";
import {
  buildRemotePluginPermissionConsentRequest,
  diffRemotePluginPermissions,
  getRemotePluginManifestPermissionTags,
} from "./manifest.js";
import type { RemotePluginManifest } from "./types.js";

const manifest: RemotePluginManifest = {
  id: "bunny.search",
  name: "Search",
  version: "0.1.0",
  description: "Search files",
  mode: "background",
  permissions: {
    host: { storage: true },
    bun: { read: true, write: true },
    isolation: "shared-worker",
  },
  view: {
    relativePath: "views/main/index.html",
    title: "Search",
    width: 900,
    height: 640,
  },
  worker: { relativePath: "worker.js" },
};

describe("remote plugin manifests", () => {
  it("flattens manifest permissions", () => {
    expect(getRemotePluginManifestPermissionTags(manifest)).toEqual([
      "host:storage",
      "bun:read",
      "bun:write",
      "isolation:shared-worker",
    ]);
  });

  it("diffs new permissions against an existing grant", () => {
    expect(
      diffRemotePluginPermissions(manifest.permissions, {
        host: { storage: true },
        bun: { read: true },
        isolation: "shared-worker",
      }),
    ).toEqual({
      requestedPermissions: [
        "host:storage",
        "bun:read",
        "bun:write",
        "isolation:shared-worker",
      ],
      changedPermissions: ["bun:write"],
      hostPermissions: ["storage"],
      bunPermissions: ["read", "write"],
      isolation: "shared-worker",
    });
  });

  it("builds a consent request from manifest metadata", () => {
    const request = buildRemotePluginPermissionConsentRequest({
      requestId: "req-1",
      manifest,
      source: { kind: "local", path: "/tmp/search" },
      sourceLabel: "/tmp/search",
      message: "Install Search",
      confirmLabel: "Install",
      previousGrant: { bun: { read: true }, isolation: "shared-worker" },
    });

    expect(request).toEqual({
      requestId: "req-1",
      remotePluginId: "bunny.search",
      remotePluginName: "Search",
      version: "0.1.0",
      sourceKind: "local",
      sourceLabel: "/tmp/search",
      message: "Install Search",
      confirmLabel: "Install",
      requestedPermissions: [
        "host:storage",
        "bun:read",
        "bun:write",
        "isolation:shared-worker",
      ],
      changedPermissions: ["host:storage", "bun:write"],
      hostPermissions: ["storage"],
      bunPermissions: ["read", "write"],
      isolation: "shared-worker",
    });
  });
});
