import { describe, expect, it } from "bun:test";
import {
  flattenRemotePluginPermissions,
  hasBunPermission,
  hasHostPermission,
  isRemotePluginPermissionTag,
  mergeRemotePluginPermissions,
  normalizeRemotePluginPermissions,
  parseRemotePluginPermissionTag,
  toBunWorkerPermissions,
} from "./permissions.js";
import type {
  RemotePluginPermissionGrant,
  RemotePluginPermissionTag,
} from "./types.js";

describe("remote plugin permissions", () => {
  it("normalizes legacy permissions into host and bun grants", () => {
    const grant = normalizeRemotePluginPermissions([
      "bun:fs",
      "bun:env",
      "bun:child_process",
      "notifications",
    ]);

    expect(grant).toEqual({
      host: { notifications: true },
      bun: { read: true, write: true, env: true, run: true },
      isolation: "shared-worker",
    });
  });

  it("treats legacy bare bun permission as a no-op compatibility token", () => {
    expect(normalizeRemotePluginPermissions(["bun"])).toEqual({
      host: {},
      bun: {},
      isolation: "shared-worker",
    });
  });

  it("flattens structured grants into stable permission tags", () => {
    const tags = flattenRemotePluginPermissions({
      host: { windows: true, tray: false, storage: true },
      bun: { read: true, worker: true },
      isolation: "isolated-process",
    });

    expect(tags).toEqual([
      "host:windows",
      "host:storage",
      "bun:read",
      "bun:worker",
      "isolation:isolated-process",
    ] satisfies RemotePluginPermissionTag[]);
  });

  it("merges overrides over defaults", () => {
    const merged = mergeRemotePluginPermissions(
      {
        host: { storage: true },
        bun: { read: true },
        isolation: "shared-worker",
      },
      {
        host: { windows: true },
        bun: { write: true },
        isolation: "isolated-process",
      },
    );

    expect(merged).toEqual({
      host: { storage: true, windows: true },
      bun: { read: true, write: true },
      isolation: "isolated-process",
    });
  });

  it("preserves default isolation when overrides are absent or legacy-only", () => {
    expect(
      mergeRemotePluginPermissions(
        {
          bun: { read: true },
          isolation: "isolated-process",
        },
        undefined,
      ),
    ).toEqual({
      host: {},
      bun: { read: true },
      isolation: "isolated-process",
    });

    expect(
      mergeRemotePluginPermissions(
        {
          bun: { read: true },
          isolation: "isolated-process",
        },
        ["bun:env"],
      ),
    ).toEqual({
      host: {},
      bun: { read: true, env: true },
      isolation: "isolated-process",
    });
  });

  it("checks individual host and bun permissions", () => {
    const grant: RemotePluginPermissionGrant = {
      host: { tray: true },
      bun: { run: true },
    };

    expect(hasHostPermission(grant, "tray")).toBe(true);
    expect(hasHostPermission(grant, "windows")).toBe(false);
    expect(hasBunPermission(grant, "run")).toBe(true);
    expect(hasBunPermission(grant, "ffi")).toBe(false);
  });

  it("builds Bun worker permission records", () => {
    expect(
      toBunWorkerPermissions({
        bun: { read: true, write: true, run: true },
      }),
    ).toEqual({
      read: true,
      write: true,
      env: false,
      run: true,
      ffi: false,
      addons: false,
      worker: false,
    });
  });

  it("parses only canonical permission tags", () => {
    expect(parseRemotePluginPermissionTag("host:tray")).toBe("host:tray");
    expect(parseRemotePluginPermissionTag("bun:read")).toBe("bun:read");
    expect(parseRemotePluginPermissionTag("isolation:shared-worker")).toBe(
      "isolation:shared-worker",
    );
    expect(parseRemotePluginPermissionTag("host:tray:extra")).toBeNull();
    expect(parseRemotePluginPermissionTag("host:camera")).toBeNull();
    expect(isRemotePluginPermissionTag("bun:worker")).toBe(true);
    expect(isRemotePluginPermissionTag("bun:network")).toBe(false);
  });
});
