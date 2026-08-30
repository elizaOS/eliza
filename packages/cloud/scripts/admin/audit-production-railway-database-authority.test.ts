/** Exercises privacy-safe Railway resolution and dual-target read-only database audits. */
import { describe, expect, test } from "bun:test";
import {
  type AuditQueryClient,
  auditProductionDatabaseAuthority,
  canonicalRailwayDatabaseUrl,
  type ProductionDatabaseAuditReport,
  type RailwayTargetEvidence,
  REQUIRED_PRODUCTION_RELATIONS,
  resolveCanonicalRailwayTarget,
} from "./audit-production-railway-database-authority";
import type { AppliedMigration, Migration } from "./canonical-migration-ledger";

const PROJECT = "10000000-0000-4000-8000-000000000001";
const ENVIRONMENT = "20000000-0000-4000-8000-000000000002";
const SERVICE = "30000000-0000-4000-8000-000000000003";
const OTHER_SERVICE = "40000000-0000-4000-8000-000000000004";
const PINNED_IMAGE = `ghcr.io/railwayapp-templates/postgres-ssl@sha256:${"a".repeat(64)}`;
const PRIVATE_URL =
  "postgresql://operator:private-password@canonical.example.test:5432/production";

const canonicalMigrations: Migration[] = [
  {
    entry: {
      idx: 0,
      version: "7",
      when: 1_700_000_000_000,
      tag: "0194_job_execution_interruptions_catalog_guard",
      breakpoints: true,
    },
    hash: "canonical-hash",
    statements: [],
  },
];

const applied: AppliedMigration[] = [
  {
    id: 1,
    hash: "canonical-hash",
    created_at: 1_700_000_000_000,
  },
];

function railwayEvidence(): RailwayTargetEvidence {
  return {
    status: {
      id: PROJECT,
      environments: {
        edges: [{ node: { id: ENVIRONMENT, name: "production" } }],
      },
      services: { edges: [{ node: { id: SERVICE, name: "Postgres" } }] },
    },
    services: [
      {
        id: SERVICE,
        source: { image: "ghcr.io/railwayapp-templates/postgres-ssl:18" },
      },
    ],
    variables: { DATABASE_PUBLIC_URL: PRIVATE_URL, ANOTHER_SECRET: "private" },
  };
}

function allPresent(): Record<string, boolean> {
  return Object.fromEntries(
    REQUIRED_PRODUCTION_RELATIONS.map((relation) => [relation, true]),
  );
}

class FakeClient implements AuditQueryClient {
  readonly statements: string[] = [];

  constructor(
    private readonly identity: {
      system_identifier: string;
      database_name: string;
      role_name: string;
      server_version_num: string;
    },
    private readonly presence = allPresent(),
    private readonly ledger = applied,
  ) {}

  async query<T = unknown>(text: string): Promise<{ rows: T[] }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("pg_catalog.pg_control_system()")) {
      return { rows: [this.identity as T] };
    }
    if (sql.includes("to_regclass('public.apps')")) {
      return { rows: [this.presence as T] };
    }
    if (sql.includes("FROM drizzle.__drizzle_migrations")) {
      return { rows: this.ledger as T[] };
    }
    throw new Error("unhandled fake read-only query");
  }
}

function identity(
  overrides: Partial<{
    system_identifier: string;
    database_name: string;
    role_name: string;
    server_version_num: string;
  }> = {},
) {
  return {
    system_identifier: "1234567890123456789",
    database_name: "production",
    role_name: "operator",
    server_version_num: "180001",
    ...overrides,
  };
}

async function audit(
  protectedClient = new FakeClient(identity()),
  canonicalClient = new FakeClient(identity()),
): Promise<ProductionDatabaseAuditReport> {
  return auditProductionDatabaseAuthority({
    protectedClient,
    canonicalClient,
    canonicalMigrations,
  });
}

describe("canonical Railway target", () => {
  test("discovers exactly one Postgres 18 service when no protected ID is configured", () => {
    const evidence = railwayEvidence();
    expect(
      resolveCanonicalRailwayTarget(evidence, {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
      }),
    ).toEqual({ verdict: "match", serviceId: SERVICE });
    expect(
      resolveCanonicalRailwayTarget(
        {
          ...evidence,
          services: [{ id: SERVICE, source: { image: "postgres:17" } }],
        },
        {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
        },
      ),
    ).toEqual({ verdict: "unavailable" });
  });

  test("fails safely on zero or multiple candidates", () => {
    const evidence = railwayEvidence();
    expect(
      resolveCanonicalRailwayTarget(
        { ...evidence, services: [] },
        { projectId: PROJECT, environmentId: ENVIRONMENT },
      ),
    ).toEqual({ verdict: "unavailable" });
    expect(
      resolveCanonicalRailwayTarget(
        {
          ...evidence,
          services: [
            ...evidence.services,
            {
              id: "40000000-0000-4000-8000-000000000004",
              source: { image: "postgres:18" },
            },
          ],
        },
        { projectId: PROJECT, environmentId: ENVIRONMENT },
      ),
    ).toEqual({ verdict: "unavailable" });
  });

  test("requires an optional protected service ID to match discovery", () => {
    const evidence = railwayEvidence();
    expect(
      resolveCanonicalRailwayTarget(evidence, {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        serviceId: SERVICE,
      }),
    ).toEqual({ verdict: "match", serviceId: SERVICE });
    expect(
      resolveCanonicalRailwayTarget(evidence, {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        serviceId: OTHER_SERVICE,
      }),
    ).toEqual({ verdict: "mismatch" });
  });

  test("accepts a digest-immutable Postgres image only through an exact protected pin", () => {
    const evidence = railwayEvidence();
    const digestPinned = {
      ...evidence,
      services: [{ id: SERVICE, source: { image: PINNED_IMAGE } }],
    };
    expect(
      resolveCanonicalRailwayTarget(digestPinned, {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        serviceId: SERVICE,
      }),
    ).toEqual({ verdict: "match", serviceId: SERVICE });
    expect(
      resolveCanonicalRailwayTarget(digestPinned, {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
      }),
    ).toEqual({ verdict: "unavailable" });

    expect(
      resolveCanonicalRailwayTarget(
        {
          ...digestPinned,
          services: [
            ...digestPinned.services,
            { id: OTHER_SERVICE, source: { image: "postgres:18" } },
          ],
          status: {
            ...digestPinned.status,
            services: {
              edges: [
                { node: { id: SERVICE, name: "Postgres" } },
                { node: { id: OTHER_SERVICE, name: "Postgres Legacy" } },
              ],
            },
          },
        },
        {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          serviceId: SERVICE,
        },
      ),
    ).toEqual({ verdict: "match", serviceId: SERVICE });
  });

  test("fails closed when the protected pin is absent, duplicated, or not Postgres", () => {
    const evidence = railwayEvidence();
    for (const services of [
      [],
      [
        { id: SERVICE, source: { image: PINNED_IMAGE } },
        { id: SERVICE, source: { image: PINNED_IMAGE } },
      ],
      [{ id: SERVICE, source: { image: "redis:8" } }],
    ]) {
      expect(
        resolveCanonicalRailwayTarget(
          { ...evidence, services },
          {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            serviceId: SERVICE,
          },
        ),
      ).toEqual({ verdict: "mismatch" });
    }
  });

  test("accepts only the selected service's public PostgreSQL URL", () => {
    expect(canonicalRailwayDatabaseUrl(railwayEvidence().variables)).toBe(
      PRIVATE_URL,
    );
    expect(() =>
      canonicalRailwayDatabaseUrl({ DATABASE_URL: PRIVATE_URL }),
    ).toThrow("canonical_database_url_unavailable");
    expect(() =>
      canonicalRailwayDatabaseUrl({ DATABASE_PUBLIC_URL: "https://private" }),
    ).toThrow("canonical_database_url_invalid");
  });
});

describe("read-only database audit", () => {
  test("passes only when authority, every required table, and the full ledger match", async () => {
    const protectedClient = new FakeClient(identity());
    const canonicalClient = new FakeClient(identity());
    const report = await audit(protectedClient, canonicalClient);
    expect(report).toEqual({
      schemaVersion: 1,
      verdict: "pass",
      checks: {
        railwayTarget: "match",
        protectedDatabaseAuthority: "match",
      },
      requiredTables: {
        canonical: Object.fromEntries(
          REQUIRED_PRODUCTION_RELATIONS.map((relation) => [
            relation,
            "present",
          ]),
        ),
        protected: Object.fromEntries(
          REQUIRED_PRODUCTION_RELATIONS.map((relation) => [
            relation,
            "present",
          ]),
        ),
      },
      migrationLedger: { canonical: "current", protected: "current" },
    });
    for (const statement of [
      ...protectedClient.statements,
      ...canonicalClient.statements,
    ]) {
      expect(statement).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i,
      );
    }
    expect(protectedClient.statements[0]).toContain("READ ONLY");
    expect(canonicalClient.statements[0]).toContain("READ ONLY");
    const relationQuery = canonicalClient.statements.find((statement) =>
      statement.includes("to_regclass('public.apps')"),
    );
    expect(relationQuery).toContain("to_regclass('public.jobs')");
    expect(relationQuery).toContain("to_regclass('public.agent_sandboxes')");
  });

  test("distinguishes a wrong protected target from a healthy canonical target", async () => {
    const protectedPresence = allPresent();
    protectedPresence["public.mobile_app_auth_grants"] = false;
    const report = await audit(
      new FakeClient(
        identity({ database_name: "wrong-private-name" }),
        protectedPresence,
        [],
      ),
      new FakeClient(identity()),
    );
    expect(report.verdict).toBe("fail");
    expect(report.checks.protectedDatabaseAuthority).toBe("mismatch");
    expect(
      report.requiredTables.canonical["public.mobile_app_auth_grants"],
    ).toBe("present");
    expect(
      report.requiredTables.protected["public.mobile_app_auth_grants"],
    ).toBe("missing");
    expect(report.migrationLedger).toEqual({
      canonical: "current",
      protected: "pending",
    });
    const output = JSON.stringify(report);
    expect(output).not.toContain("wrong-private-name");
    expect(output).not.toContain("operator");
    expect(output).not.toContain(PROJECT);
    expect(output).not.toContain(PRIVATE_URL);
  });

  test("rejects a matching authority unless both targets run PostgreSQL 18", async () => {
    for (const [protectedMajor, canonicalMajor] of [
      ["170009", "180001"],
      ["180001", "170009"],
      ["170009", "170009"],
    ]) {
      const report = await audit(
        new FakeClient(identity({ server_version_num: protectedMajor })),
        new FakeClient(identity({ server_version_num: canonicalMajor })),
      );
      expect(report.verdict).toBe("fail");
      expect(report.checks.protectedDatabaseAuthority).toBe("mismatch");
    }
  });

  test("fails when the protected provisioning jobs relation is missing", async () => {
    const presence = allPresent();
    presence["public.jobs"] = false;
    const report = await audit(
      new FakeClient(identity(), presence),
      new FakeClient(identity()),
    );
    expect(report.verdict).toBe("fail");
    expect(report.requiredTables.protected["public.jobs"]).toBe("missing");
    expect(report.requiredTables.canonical["public.jobs"]).toBe("present");
    expect(report.migrationLedger).toEqual({
      canonical: "current",
      protected: "current",
    });
  });

  test("reports fixed table presence and pending ledger status", async () => {
    const presence = allPresent();
    presence["public.mobile_app_auth_grants"] = false;
    const report = await audit(
      new FakeClient(identity(), presence, []),
      new FakeClient(identity()),
    );
    expect(report.verdict).toBe("fail");
    expect(
      report.requiredTables.protected["public.mobile_app_auth_grants"],
    ).toBe("missing");
    expect(
      report.requiredTables.canonical["public.mobile_app_auth_grants"],
    ).toBe("present");
    expect(report.migrationLedger).toEqual({
      canonical: "current",
      protected: "pending",
    });
  });

  test("classifies a noncanonical ledger as diverged without returning row data", async () => {
    const report = await audit(
      new FakeClient(identity(), allPresent(), [
        { ...applied[0], hash: "private-wrong-hash" },
      ]),
      new FakeClient(identity()),
    );
    expect(report.verdict).toBe("fail");
    expect(report.migrationLedger).toEqual({
      canonical: "current",
      protected: "diverged",
    });
    expect(JSON.stringify(report)).not.toContain("private-wrong-hash");
  });

  test("fails when the canonical sandbox inventory relation is missing", async () => {
    const canonicalPresence = allPresent();
    canonicalPresence["public.agent_sandboxes"] = false;
    const report = await audit(
      new FakeClient(identity()),
      new FakeClient(identity(), canonicalPresence),
    );
    expect(report.verdict).toBe("fail");
    expect(report.checks.protectedDatabaseAuthority).toBe("match");
    expect(report.requiredTables.canonical["public.agent_sandboxes"]).toBe(
      "missing",
    );
    expect(report.requiredTables.protected["public.agent_sandboxes"]).toBe(
      "present",
    );
    expect(report.migrationLedger).toEqual({
      canonical: "current",
      protected: "current",
    });
  });

  test("reports canonical schema and ledger drift independently", async () => {
    const canonicalPresence = allPresent();
    canonicalPresence["public.apps"] = false;
    const report = await audit(
      new FakeClient(identity()),
      new FakeClient(identity(), canonicalPresence, [
        { ...applied[0], hash: "canonical-wrong-hash" },
      ]),
    );
    expect(report.verdict).toBe("fail");
    expect(report.checks.protectedDatabaseAuthority).toBe("match");
    expect(report.requiredTables.canonical["public.apps"]).toBe("missing");
    expect(report.requiredTables.protected["public.apps"]).toBe("present");
    expect(report.migrationLedger).toEqual({
      canonical: "diverged",
      protected: "current",
    });
    expect(JSON.stringify(report)).not.toContain("canonical-wrong-hash");
  });

  test("reports matching authority with the same missing canonical relation", async () => {
    const droppedPresence = allPresent();
    droppedPresence["steward.sessions"] = false;
    const report = await audit(
      new FakeClient(identity(), droppedPresence),
      new FakeClient(identity(), droppedPresence),
    );
    expect(report.verdict).toBe("fail");
    expect(report.checks.protectedDatabaseAuthority).toBe("match");
    expect(report.requiredTables.canonical["steward.sessions"]).toBe("missing");
    expect(report.requiredTables.protected["steward.sessions"]).toBe("missing");
    expect(report.migrationLedger).toEqual({
      canonical: "current",
      protected: "current",
    });
  });
});
