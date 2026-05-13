import { describe, expect, it } from "bun:test";
import {
  flattenCarrotPermissions,
  hasBunPermission,
  hasHostPermission,
  isCarrotPermissionTag,
  mergeCarrotPermissions,
  normalizeCarrotPermissions,
  parseCarrotPermissionTag,
  toBunWorkerPermissions,
} from "./permissions.js";
import type { CarrotPermissionGrant, CarrotPermissionTag } from "./types.js";

describe("carrot permissions", () => {
  it("normalizes legacy permissions into host and bun grants", () => {
    const grant = normalizeCarrotPermissions([
      "bun",
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

  it("flattens structured grants into stable permission tags", () => {
    const tags = flattenCarrotPermissions({
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
    ] satisfies CarrotPermissionTag[]);
  });

  it("merges overrides over defaults", () => {
    const merged = mergeCarrotPermissions(
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

  it("checks individual host and bun permissions", () => {
    const grant: CarrotPermissionGrant = {
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
    expect(parseCarrotPermissionTag("host:tray")).toBe("host:tray");
    expect(parseCarrotPermissionTag("bun:read")).toBe("bun:read");
    expect(parseCarrotPermissionTag("isolation:shared-worker")).toBe(
      "isolation:shared-worker",
    );
    expect(parseCarrotPermissionTag("host:camera")).toBeNull();
    expect(isCarrotPermissionTag("bun:worker")).toBe(true);
    expect(isCarrotPermissionTag("bun:network")).toBe(false);
  });
});
