/**
 * Smoke tests for the local-dev Helm values files in
 * `cloud/infra/cloud/local/`. These files are consumed by external charts
 * (CNPG, Bitnami Redis) when bringing up the local kind cluster — a typo
 * here will break `setup.sh` silently, so we verify them as structured YAML
 * with the keys those charts require.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const LOCAL_DIR = join(import.meta.dir, "..", "cloud", "local");

function loadYaml(file: string): unknown {
  const raw = readFileSync(join(LOCAL_DIR, file), "utf-8");
  return parseYaml(raw);
}

describe("values-pg-local.yaml (CNPG local PostgreSQL)", () => {
  const doc = loadYaml("values-pg-local.yaml") as Record<string, unknown>;

  test("parses as a non-null object", () => {
    expect(doc).not.toBeNull();
    expect(typeof doc).toBe("object");
  });

  test("declares PostgreSQL standalone mode", () => {
    expect(doc.type).toBe("postgresql");
    expect(doc.mode).toBe("standalone");
  });

  test("pins the PostgreSQL major version", () => {
    const version = doc.version as Record<string, unknown>;
    expect(version).toBeDefined();
    expect(version.postgresql).toBe("17");
  });

  test("configures a single-instance cluster with initdb DB and owner", () => {
    const cluster = doc.cluster as Record<string, unknown>;
    expect(cluster).toBeDefined();
    expect(cluster.instances).toBe(1);
    const initdb = cluster.initdb as Record<string, unknown>;
    expect(initdb.database).toBe("app");
    expect(initdb.owner).toBe("app");
  });

  test("seeds the vector + uuid-ossp extensions used by app-core", () => {
    const cluster = doc.cluster as Record<string, unknown>;
    const initdb = cluster.initdb as Record<string, unknown>;
    const sql = initdb.postInitApplicationSQL as string[];
    expect(Array.isArray(sql)).toBe(true);
    expect(sql.some((s) => s.includes("vector"))).toBe(true);
    expect(sql.some((s) => s.includes("uuid-ossp"))).toBe(true);
  });

  test("declares the rw pooler used by the app connection string", () => {
    const poolers = doc.poolers as Array<Record<string, unknown>>;
    expect(Array.isArray(poolers)).toBe(true);
    const rw = poolers.find((p) => p.name === "rw");
    expect(rw).toBeDefined();
    expect(rw?.type).toBe("rw");
  });
});

describe("values-redis-local.yaml (Bitnami Redis chart)", () => {
  const doc = loadYaml("values-redis-local.yaml") as Record<string, unknown>;

  test("parses as a non-null object", () => {
    expect(doc).not.toBeNull();
    expect(typeof doc).toBe("object");
  });

  test("declares standalone architecture (no sentinel/cluster)", () => {
    expect(doc.architecture).toBe("standalone");
  });

  test("disables auth for the local-dev cluster", () => {
    const auth = doc.auth as Record<string, unknown>;
    expect(auth).toBeDefined();
    expect(auth.enabled).toBe(false);
  });

  test("sets master resources for the kind cluster", () => {
    const master = doc.master as Record<string, unknown>;
    expect(master).toBeDefined();
    const resources = master.resources as Record<string, unknown>;
    const requests = resources.requests as Record<string, unknown>;
    const limits = resources.limits as Record<string, unknown>;
    expect(requests).toEqual({
      memory: "64Mi",
      cpu: "50m",
    });
    expect(limits).toEqual({
      memory: "128Mi",
    });
  });
});
