import { describe, expect, test } from "bun:test";
import {
  deprovisionTenantDbForApp,
  parseDsnHost,
  type TenantDbDeprovisionDeps,
} from "../tenant-db-deprovision";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const DSN = "postgresql://app_x:p%40ss@10.30.1.10:5432/db_app_x?sslmode=require";

describe("parseDsnHost", () => {
  test("extracts the host from a full DSN (creds + port + query stripped)", () => {
    expect(parseDsnHost(DSN)).toBe("10.30.1.10");
    expect(parseDsnHost("postgres://u:p@db.internal:5432/x")).toBe("db.internal");
    expect(parseDsnHost("postgresql://u@HOST.example/db")).toBe("host.example");
  });
  test("returns null for an unparseable / hostless DSN", () => {
    expect(parseDsnHost("not a dsn")).toBeNull();
    expect(parseDsnHost("")).toBeNull();
  });
});

function deps(over: Partial<TenantDbDeprovisionDeps> = {}) {
  const calls: string[] = [];
  const base: TenantDbDeprovisionDeps = {
    async resolveClusterByHost(host) {
      calls.push(`resolve:${host}`);
      return { id: "cluster-1", adminDsn: "postgresql://admin@10.30.1.10/postgres" };
    },
    makeDeprovisioner(adminDsn, host) {
      calls.push(`make:${host}`);
      return {
        async deprovision(appId) {
          calls.push(`drop:${appId}`);
          return { existed: true };
        },
      };
    },
    async releaseSlot(clusterId) {
      calls.push(`release:${clusterId}`);
    },
  };
  return { calls, deps: { ...base, ...over } };
}

describe("deprovisionTenantDbForApp", () => {
  test("resolves the cluster, DROPs the DB, THEN releases the slot (order matters)", async () => {
    const { calls, deps: d } = deps();
    const result = await deprovisionTenantDbForApp(APP_ID, DSN, d);

    expect(result).toEqual({ deprovisioned: true });
    expect(calls).toEqual([
      "resolve:10.30.1.10",
      "make:10.30.1.10",
      `drop:${APP_ID}`,
      "release:cluster-1",
    ]);
  });

  test("no-op when the DSN has no parseable host (nothing to drop)", async () => {
    const { calls, deps: d } = deps();
    const result = await deprovisionTenantDbForApp(APP_ID, "garbage", d);
    expect(result).toEqual({ deprovisioned: false, reason: "no-host" });
    expect(calls).toEqual([]); // never touches the cluster
  });

  test("no-op when no cluster owns the host (shared-mode / already-removed)", async () => {
    let dropped = false;
    let released = false;
    const result = await deprovisionTenantDbForApp(APP_ID, DSN, {
      async resolveClusterByHost() {
        return null;
      },
      makeDeprovisioner() {
        dropped = true;
        return {
          async deprovision() {
            return { existed: true };
          },
        };
      },
      async releaseSlot() {
        released = true;
      },
    });
    expect(result).toEqual({ deprovisioned: false, reason: "unknown-cluster" });
    // resolve returned null -> nothing dropped or released
    expect(dropped).toBe(false);
    expect(released).toBe(false);
  });

  test("a failed DROP propagates and does NOT release the slot (DB still live)", async () => {
    const released: string[] = [];
    const { deps: d } = deps({
      makeDeprovisioner() {
        return {
          async deprovision() {
            throw new Error("connection refused");
          },
        };
      },
      async releaseSlot(id) {
        released.push(id);
      },
    });
    await expect(deprovisionTenantDbForApp(APP_ID, DSN, d)).rejects.toThrow("connection refused");
    expect(released).toEqual([]); // slot stays counted — the DB wasn't dropped
  });

  test("does NOT release the slot when the DB was already gone (idempotent re-run, no double-free)", async () => {
    const released: string[] = [];
    const { calls, deps: d } = deps({
      makeDeprovisioner(adminDsn, host) {
        return {
          async deprovision(appId) {
            calls.push(`drop:${appId}@${host}`);
            // The DROP IF EXISTS ran but the DB was already gone (a re-run after
            // a prior successful deprovision) — so the slot must NOT be freed
            // again. (#8342)
            return { existed: false };
          },
        };
      },
      async releaseSlot(id) {
        released.push(id);
      },
    });
    const result = await deprovisionTenantDbForApp(APP_ID, DSN, d);
    expect(result).toEqual({ deprovisioned: true }); // teardown still ran / desired state reached
    expect(released).toEqual([]); // but the slot was NOT decremented a second time
  });
});
