import { describe, expect, test } from "bun:test";
import {
  parseCliArgs,
  type ResilienceEvidence,
  verifyRailwayPostgresResilience,
} from "./preflight-railway-postgres-resilience";

const PROJECT = "10000000-0000-4000-8000-000000000001";
const STAGING_ENV = "20000000-0000-4000-8000-000000000002";
const SERVICE = "30000000-0000-4000-8000-000000000003";
const VOLUME = "40000000-0000-4000-8000-000000000004";
const VOLUME_INSTANCE = "50000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-08-18T04:00:00.000Z");

function evidence(
  overrides: Partial<ResilienceEvidence> = {},
): ResilienceEvidence {
  return {
    status: {
      id: PROJECT,
      environments: { edges: [{ node: { id: STAGING_ENV, name: "staging" } }] },
      services: {
        edges: [{ node: { id: SERVICE, name: "Postgres-staging" } }],
      },
    },
    services: [
      {
        id: SERVICE,
        name: "Postgres-staging",
        source: { image: "ghcr.io/railwayapp-templates/postgres-ssl:18" },
        volumes: [
          {
            name: "staging-postgres-volume",
            mountPath: "/var/lib/postgresql/data",
            sizeMb: 50_000,
            state: "READY",
          },
        ],
      },
    ],
    volumes: {
      data: {
        environment: {
          id: STAGING_ENV,
          volumeInstances: {
            edges: [
              {
                node: {
                  id: VOLUME_INSTANCE,
                  volumeId: VOLUME,
                  environmentId: STAGING_ENV,
                  serviceId: SERVICE,
                  mountPath: "/var/lib/postgresql/data",
                  sizeMB: 50_000,
                  state: "READY",
                  deletedAt: null,
                  isPendingDeletion: false,
                },
              },
            ],
          },
        },
      },
    },
    pitr: {
      service: { id: SERVICE, name: "Postgres-staging" },
      root: { id: SERVICE, name: "Postgres-staging" },
      environment: { id: STAGING_ENV, name: "staging" },
      enabled: true,
      bucketWired: true,
    },
    schedules: [
      { id: "daily", kind: "DAILY", retentionSeconds: 604_800 },
      { id: "weekly", kind: "WEEKLY", retentionSeconds: 2_592_000 },
    ],
    backups: [
      {
        id: "backup-1",
        createdAt: "2026-08-18T03:00:00.000Z",
        scheduleId: "daily",
      },
    ],
    ...overrides,
  };
}

function expectation() {
  return {
    environment: "staging" as const,
    projectId: PROJECT,
    environmentId: STAGING_ENV,
    serviceId: SERVICE,
    productionServiceReceipt: "a".repeat(64),
    productionVolumeReceipt: "b".repeat(64),
    maxBackupAgeHours: 36,
  };
}

describe("Railway PostgreSQL resilience preflight", () => {
  test("passes only with recovery coverage and physical staging isolation", () => {
    const result = verifyRailwayPostgresResilience(
      evidence(),
      expectation(),
      NOW,
    );

    expect(result.verdict).toBe("pass");
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.receipts.service).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipts.volume).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("staging-postgres-volume");
    expect(JSON.stringify(result)).not.toContain(SERVICE);
  });

  test.each([
    ["PITR disabled", { pitr: { ...evidence().pitr, enabled: false } }],
    ["bucket missing", { pitr: { ...evidence().pitr, bucketWired: false } }],
    ["daily schedule missing", { schedules: evidence().schedules.slice(1) }],
    [
      "weekly schedule missing",
      { schedules: evidence().schedules.slice(0, 1) },
    ],
    [
      "scheduled backup stale",
      {
        backups: [
          {
            id: "old",
            createdAt: "2026-08-15T00:00:00.000Z",
            scheduleId: "daily",
          },
        ],
      },
    ],
    [
      "manual backup only",
      {
        backups: [
          { id: "manual", createdAt: NOW.toISOString(), scheduleId: null },
        ],
      },
    ],
  ])("fails closed when %s", (_name, override) => {
    expect(
      verifyRailwayPostgresResilience(
        evidence(override as Partial<ResilienceEvidence>),
        expectation(),
        NOW,
      ).verdict,
    ).toBe("fail");
  });

  test("rejects a shared production service or volume receipt", () => {
    const baseline = verifyRailwayPostgresResilience(
      evidence(),
      expectation(),
      NOW,
    );
    expect(
      verifyRailwayPostgresResilience(
        evidence(),
        {
          ...expectation(),
          productionServiceReceipt: baseline.receipts.service ?? "",
        },
        NOW,
      ).checks.physicallyDistinctService,
    ).toBe(false);
    expect(
      verifyRailwayPostgresResilience(
        evidence(),
        {
          ...expectation(),
          productionVolumeReceipt: baseline.receipts.volume ?? "",
        },
        NOW,
      ).checks.physicallyDistinctVolume,
    ).toBe(false);
  });

  test("hashes immutable volume-instance identity, not mutable labels", () => {
    const baseline = verifyRailwayPostgresResilience(
      evidence(),
      expectation(),
      NOW,
    );
    const renamed = evidence({
      services: [
        {
          ...evidence().services[0],
          volumes: [
            {
              ...evidence().services[0].volumes?.[0],
              name: "renamed-service-volume-label",
            },
          ],
        },
      ],
      volumes: {
        ...evidence().volumes,
        data: {
          environment: {
            ...evidence().volumes.data?.environment,
            volumeInstances: {
              edges: [
                {
                  node: {
                    ...evidence().volumes.data?.environment?.volumeInstances
                      ?.edges?.[0].node,
                    id: VOLUME_INSTANCE,
                  },
                },
              ],
            },
          },
        },
      },
    });
    const result = verifyRailwayPostgresResilience(
      renamed,
      {
        ...expectation(),
        productionVolumeReceipt: baseline.receipts.volume ?? "",
      },
      NOW,
    );
    expect(result.receipts.volume).toBe(baseline.receipts.volume);
    expect(result.checks.physicallyDistinctVolume).toBe(false);

    const distinctInstance = evidence({
      volumes: {
        ...evidence().volumes,
        data: {
          environment: {
            ...evidence().volumes.data?.environment,
            volumeInstances: {
              edges: [
                {
                  node: {
                    ...evidence().volumes.data?.environment?.volumeInstances
                      ?.edges?.[0].node,
                    id: "70000000-0000-4000-8000-000000000007",
                  },
                },
              ],
            },
          },
        },
      },
    });
    const distinctResult = verifyRailwayPostgresResilience(
      distinctInstance,
      {
        ...expectation(),
        productionVolumeReceipt: baseline.receipts.volume ?? "",
      },
      NOW,
    );
    expect(distinctResult.receipts.volume).not.toBe(baseline.receipts.volume);
    expect(distinctResult.checks.physicallyDistinctVolume).toBe(true);
  });

  test("fails closed when immutable volume evidence is unbound or errored", () => {
    const foreignTarget = evidence({
      volumes: {
        data: {
          environment: {
            id: STAGING_ENV,
            volumeInstances: {
              edges: [
                {
                  node: {
                    ...evidence().volumes.data?.environment?.volumeInstances
                      ?.edges?.[0].node,
                    serviceId: "60000000-0000-4000-8000-000000000006",
                  },
                },
              ],
            },
          },
        },
      },
    });
    const errored = evidence({
      volumes: {
        ...evidence().volumes,
        errors: [{ message: "redacted" }],
      },
    });
    const foreignProject = evidence({
      status: {
        ...evidence().status,
        id: "60000000-0000-4000-8000-000000000006",
      },
    });

    expect(
      verifyRailwayPostgresResilience(foreignTarget, expectation(), NOW).checks
        .immutableVolumeBound,
    ).toBe(false);
    expect(
      verifyRailwayPostgresResilience(errored, expectation(), NOW).checks
        .immutableVolumeBound,
    ).toBe(false);
    const foreignProjectResult = verifyRailwayPostgresResilience(
      foreignProject,
      expectation(),
      NOW,
    );
    expect(foreignProjectResult.checks.immutableVolumeBound).toBe(false);
    expect(foreignProjectResult.receipts.volume).toBeNull();
  });

  test("requires exact project, environment, service, image, and volume bindings", () => {
    const result = verifyRailwayPostgresResilience(
      evidence({
        status: {
          id: "wrong",
          environments: { edges: [] },
          services: { edges: [] },
        },
        services: [
          {
            id: SERVICE,
            source: { image: "postgres:17" },
            volumes: [
              {
                name: "wrong",
                mountPath: "/data",
                sizeMb: 10,
                state: "READY",
              },
            ],
          },
        ],
        pitr: { ...evidence().pitr, service: { id: "wrong" } },
      }),
      expectation(),
      NOW,
    );

    expect(result.verdict).toBe("fail");
    expect(result.checks).toMatchObject({
      projectBound: false,
      environmentBound: false,
      serviceBound: false,
      exactPostgres18Service: false,
      exactReadyVolume: false,
      pitrTargetBound: false,
    });
  });

  test("production emits canonical receipts without requiring isolation inputs", () => {
    const production = evidence({
      status: {
        id: PROJECT,
        environments: {
          edges: [{ node: { id: STAGING_ENV, name: "production" } }],
        },
        services: { edges: [{ node: { id: SERVICE, name: "Postgres" } }] },
      },
      pitr: {
        ...evidence().pitr,
        environment: { id: STAGING_ENV, name: "production" },
      },
    });
    const result = verifyRailwayPostgresResilience(
      production,
      {
        environment: "production",
        projectId: PROJECT,
        environmentId: STAGING_ENV,
        serviceId: SERVICE,
        maxBackupAgeHours: 36,
      },
      NOW,
    );
    expect(result.verdict).toBe("pass");
    expect(result.checks.physicallyDistinctService).toBeUndefined();
  });

  test("CLI parsing rejects report/enforce ambiguity and malformed receipts", () => {
    const common = [
      "--mode",
      "enforce",
      "--environment",
      "staging",
      "--project-id",
      PROJECT,
      "--environment-id",
      STAGING_ENV,
      "--service-id",
      SERVICE,
      "--status-json",
      "/tmp/status.json",
      "--services-json",
      "/tmp/services.json",
      "--pitr-json",
      "/tmp/pitr.json",
      "--volumes-json",
      "/tmp/volumes.json",
      "--schedules-json",
      "/tmp/schedules.json",
      "--backups-json",
      "/tmp/backups.json",
    ];
    expect(
      parseCliArgs([
        ...common,
        "--production-service-receipt",
        "a".repeat(64),
        "--production-volume-receipt",
        "b".repeat(64),
      ]).mode,
    ).toBe("enforce");
    expect(() => parseCliArgs(common)).not.toThrow();
    expect(() => parseCliArgs(["--mode", "off", ...common.slice(2)])).toThrow(
      "--mode must be report or enforce",
    );
  });
});
