/**
 * Exercises Docker node scheduling filters and metadata stamping without a live database.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realHelpers from "../helpers";

let capturedWhere: SQL | undefined;
let capturedUpdateWhere: SQL | undefined;
let capturedSet: Record<string, unknown> | undefined;

const limit = mock(() => []);
const orderBy = mock(() => ({ limit }));
const where = mock((clause: SQL) => {
  capturedWhere = clause;
  return { orderBy, limit };
});
const from = mock(() => ({ where }));
const select = mock(() => ({ from }));

const returning = mock(() => []);
const values = mock(() => ({ returning }));
const insert = mock(() => ({ values }));
const updateWhere = mock((clause: SQL) => {
  capturedUpdateWhere = clause;
  return { returning };
});
const set = mock((values: Record<string, unknown>) => {
  capturedSet = values;
  return { where: updateWhere };
});
const update = mock(() => ({ set }));

let useRepositoryMocks = false;
const dbReadMock = new Proxy(realHelpers.dbRead as unknown as Record<PropertyKey, unknown>, {
  get(target, prop, receiver) {
    if (prop === "select" && useRepositoryMocks) return select;
    return Reflect.get(target, prop, receiver);
  },
});
const dbWriteMock = new Proxy(realHelpers.dbWrite as unknown as Record<PropertyKey, unknown>, {
  get(target, prop, receiver) {
    if (prop === "insert" && useRepositoryMocks) return insert;
    if (prop === "update" && useRepositoryMocks) return update;
    return Reflect.get(target, prop, receiver);
  },
});

mock.module("../helpers", () => ({
  ...realHelpers,
  dbRead: dbReadMock,
  dbWrite: dbWriteMock,
}));

afterAll(() => {
  mock.module("../helpers", () => realHelpers);
});

const originalEnvironment = process.env.ENVIRONMENT;

describe("DockerNodesRepository environment guard", () => {
  beforeEach(() => {
    useRepositoryMocks = true;
    capturedWhere = undefined;
    capturedUpdateWhere = undefined;
    capturedSet = undefined;
    process.env.ENVIRONMENT = "staging";
  });

  afterEach(() => {
    useRepositoryMocks = false;
    process.env.ENVIRONMENT = originalEnvironment;
  });

  test("stamps the current deployment environment without overwriting explicit provenance", async () => {
    const { stampDockerNodeEnvironmentMetadata } = await import("./docker-nodes");

    expect(stampDockerNodeEnvironmentMetadata({ provider: "operator" })).toEqual({
      provider: "operator",
      environment: "staging",
    });
    expect(
      stampDockerNodeEnvironmentMetadata({
        provider: "operator",
        environment: "production",
      }),
    ).toEqual({
      provider: "operator",
      environment: "production",
    });
  });

  test("findEnabled excludes nodes stamped for a different deployment environment", async () => {
    const { DockerNodesRepository } = await import("./docker-nodes");

    await new DockerNodesRepository().findEnabled();

    if (!capturedWhere) throw new Error("findEnabled did not build a where clause");
    const sql = new PgDialect().sqlToQuery(capturedWhere).sql.toLowerCase();
    expect(sql).toContain("enabled");
    expect(sql).toContain("metadata");
    expect(sql).toContain("->>'environment'");
    expect(sql).toContain("coalesce");
    expect(sql).toContain("= ''");
  });

  test("findPlaceable fails closed: an unlabeled node is not a placement target", async () => {
    const { DockerNodesRepository } = await import("./docker-nodes");

    await new DockerNodesRepository().findPlaceable();

    if (!capturedWhere) throw new Error("findPlaceable did not build a where clause");
    const query = new PgDialect().sqlToQuery(capturedWhere);
    const sql = query.sql.toLowerCase();
    // Strict equality against the deployment environment only. The historic
    // fail-open arm — COALESCE(metadata->>'environment','') = '' — let a
    // staging host registered in the production DB take production placements
    // (elizaOS/eliza#22547); its shape must never come back to a placement
    // query.
    expect(sql).toContain("->>'environment'");
    expect(query.params).toContain("staging");
    expect(sql).not.toMatch(/coalesce\([^)]*->>\s*'environment'/);
    // Exactly one reference: the strict equality. The fail-open form carried
    // two (the COALESCE('' ) arm plus the OR match arm).
    expect(sql.match(/->>'environment'/g)?.length).toBe(1);
  });

  test("setEmbeddingSidecarHealth merges into metadata instead of replacing it", async () => {
    const { DockerNodesRepository } = await import("./docker-nodes");

    await new DockerNodesRepository().setEmbeddingSidecarHealth("node-1", "missing");

    if (!capturedSet) throw new Error("setEmbeddingSidecarHealth did not build a set payload");
    // A jsonb `||` merge, not a column overwrite: concurrent writers of other
    // metadata keys (environment stamp, onboard provenance) must survive the
    // health cycle's write.
    const query = new PgDialect().sqlToQuery(capturedSet.metadata as SQL);
    expect(query.sql).toContain('"metadata" ||');
    expect(query.sql).toContain("::jsonb");
    const patch = query.params.find(
      (param) => typeof param === "string" && param.includes("embeddingSidecar"),
    ) as string;
    const parsed = JSON.parse(patch) as {
      embeddingSidecar: { status: string; checkedAt: string };
    };
    expect(parsed.embeddingSidecar.status).toBe("missing");
    expect(Date.parse(parsed.embeddingSidecar.checkedAt)).toBeGreaterThan(0);
  });

  test("generic update rejects every Docker authority identity field", async () => {
    const { DockerNodesRepository } = await import("./docker-nodes");
    const repository = new DockerNodesRepository();
    const identityMutations = [
      ["id", "replacement-row"],
      ["node_id", "replacement-node"],
      ["node_incarnation", "99999999-9999-4999-8999-999999999999"],
      ["current_node_history_id", "99999999-9999-4999-8999-999999999998"],
      ["fleet_kind", "cloud"],
      ["infrastructure_provider", "hetzner"],
      ["provider_server_id", "12345"],
      ["host_key_fingerprint", "replacement-pin"],
    ] as const;

    for (const [field, value] of identityMutations) {
      await expect(repository.update("row-1", { [field]: value } as never)).rejects.toThrow(
        `cannot mutate identity field '${field}'`,
      );
      expect(capturedSet).toBeUndefined();
    }

    await expect(repository.update("row-1", { enabled: false })).resolves.toBeNull();
    expect(capturedSet).toMatchObject({ enabled: false });
  });

  test("create refuses a caller-supplied trigger-owned occurrence token", async () => {
    const { DockerNodesRepository } = await import("./docker-nodes");

    await expect(
      new DockerNodesRepository().create({
        current_node_history_id: "99999999-9999-4999-8999-999999999998",
      } as never),
    ).rejects.toThrow("cannot set trigger-owned current_node_history_id");
    expect(values).not.toHaveBeenCalled();
  });

  test("findLeastLoaded applies the same environment guard to schedulable capacity", async () => {
    const { DockerNodesRepository } = await import("./docker-nodes");

    await new DockerNodesRepository().findLeastLoaded();

    if (!capturedWhere) throw new Error("findLeastLoaded did not build a where clause");
    const sql = new PgDialect().sqlToQuery(capturedWhere).sql.toLowerCase();
    expect(sql).toContain("status");
    expect(sql).toContain("allocated_count");
    expect(sql).toContain("capacity");
    expect(sql).toContain("metadata");
    expect(sql).toContain("->>'environment'");
    expect(sql).toContain("capacityprovisional");
    // Placement predicate: fail closed, no unlabeled-row escape hatch.
    const query = new PgDialect().sqlToQuery(capturedWhere);
    expect(query.params).toContain("staging");
    expect(sql).not.toMatch(/coalesce\([^)]*->>\s*'environment'/);
    expect(sql.match(/->>'environment'/g)?.length).toBe(1);
  });

  test("reconcileProvisionalCapacity consumes the provisional marker atomically", async () => {
    const { DockerNodesRepository } = await import("./docker-nodes");

    await new DockerNodesRepository().reconcileProvisionalCapacity(
      "row-1",
      {
        capacity: 2,
        hostname: "203.0.113.10",
        ssh_port: 22,
        ssh_user: "root",
        status: "unknown",
      },
      {
        memTotalMb: 7745,
        vCpuCount: 4,
        capacityBoundBy: "memory",
      },
    );

    if (!capturedSet || !capturedUpdateWhere) {
      throw new Error("reconcileProvisionalCapacity did not build an atomic update");
    }
    const metadataQuery = new PgDialect().sqlToQuery(capturedSet.metadata as SQL);
    expect(metadataQuery.sql).toContain("capacityProvisional");
    expect(metadataQuery.sql).toContain("::jsonb");
    const whereQuery = new PgDialect().sqlToQuery(capturedUpdateWhere).sql;
    expect(whereQuery).toContain("capacityProvisional");
    expect(whereQuery).toContain("= 'true'");
  });
});
