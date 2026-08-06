/**
 * Exercises Docker node scheduling filters and metadata stamping without a live database.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realHelpers from "../helpers";

let capturedWhere: SQL | undefined;
let capturedSet: Record<string, unknown> | undefined;

const limit = mock(() => []);
const orderBy = mock(() => ({ limit }));
const where = mock((clause: SQL) => {
  capturedWhere = clause;
  return { orderBy, limit };
});
const from = mock(() => ({ where }));
const select = mock(() => ({ from }));

const updateWhere = mock(() => Promise.resolve([]));
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
  });
});
