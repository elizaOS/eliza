import { describe, expect, it } from "bun:test";
import {
  buildCarrotPermissionConsentRequest,
  diffCarrotPermissions,
  getCarrotManifestPermissionTags,
} from "./manifest.js";
import type { CarrotManifest } from "./types.js";

const manifest: CarrotManifest = {
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

describe("carrot manifests", () => {
  it("flattens manifest permissions", () => {
    expect(getCarrotManifestPermissionTags(manifest)).toEqual([
      "host:storage",
      "bun:read",
      "bun:write",
      "isolation:shared-worker",
    ]);
  });

  it("diffs new permissions against an existing grant", () => {
    expect(
      diffCarrotPermissions(manifest.permissions, {
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
    const request = buildCarrotPermissionConsentRequest({
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
      carrotId: "bunny.search",
      carrotName: "Search",
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
