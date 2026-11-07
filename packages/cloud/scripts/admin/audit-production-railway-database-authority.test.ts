import { expect, test } from "bun:test";
import {
  auditProductionDatabaseAuthority,
  REQUIRED_PRODUCTION_RELATIONS,
  unavailableAuditReport,
} from "./audit-production-railway-database-authority";
import {
  type AppliedMigration,
  loadCanonicalMigrations,
  type Migration,
  type MigrationLedgerFailure,
} from "./canonical-migration-ledger";

// Use the repository's actual SQL hashes and journal, not a separate tag mapping.
const migrations = await loadCanonicalMigrations();
const ledger = migrations.map((migration, index) => ({
  id: index + 1,
  hash: migration.hash,
  created_at: migration.entry.when,
}));
function client(
  rows: AppliedMigration[],
  cluster = "12345",
  present = true,
  version = "180000",
) {
  const queries: string[] = [];
  return {
    queries,
    async query<T = unknown>(sql: string): Promise<{ rows: T[] }> {
      queries.push(sql);
      let result: unknown[];
      if (sql.includes("pg_control_system")) {
        result = [
          {
            system_identifier: cluster,
            database_name: "private_db",
            role_name: "private_role",
            server_version_num: version,
          },
        ];
      } else if (sql.includes("to_regclass")) {
        result = [
          Object.fromEntries(
            REQUIRED_PRODUCTION_RELATIONS.map((name) => [name, present]),
          ),
        ];
      } else if (sql.includes("FROM drizzle.__drizzle_migrations")) {
        result = rows;
      } else if (
        /^(BEGIN TRANSACTION.*READ ONLY|COMMIT|ROLLBACK)/.test(sql.trim())
      ) {
        result = [];
      } else {
        throw new Error("Unexpected query in read-only audit");
      }
      return { rows: result as T[] };
    },
  };
}

test("pending tags use the validated canonical ledger and remain a failed readiness verdict", async () => {
  const canonicalClient = client(ledger.slice(0, -2));
  const protectedClient = client(ledger.slice(0, -2));
  const report = await auditProductionDatabaseAuthority({
    canonicalClient,
    protectedClient,
    canonicalMigrations: migrations,
  });
  expect(report.verdict).toBe("fail");
  expect(report.pendingMigrationTags).toEqual({
    canonical: [
      "0547_subscription_grant_calendar_terms",
      "0548_agent_provisioning_deferred_backfill",
    ],
    protected: [
      "0547_subscription_grant_calendar_terms",
      "0548_agent_provisioning_deferred_backfill",
    ],
  });
  expect(report.migrationLedger).toEqual({
    canonical: "pending",
    protected: "pending",
  });
  const serialized = JSON.stringify(report);
  for (const privateValue of [
    "private_db",
    "private_role",
    "12345",
    ledger[ledger.length - 1].hash,
  ])
    expect(serialized).not.toContain(privateValue);
  for (const c of [canonicalClient, protectedClient]) {
    expect(c.queries[0]).toContain("READ ONLY");
    expect(c.queries.at(-1)).toBe("COMMIT");
  }
});

test("current ledgers report an empty plan; missing or divergent ledgers never report one", async () => {
  for (const kind of ["current", "hash", "gap", "missing"] as const) {
    const rows =
      kind === "hash"
        ? ledger.map((row, i) =>
            i === ledger.length - 1
              ? { ...row, hash: "private_invalid_hash" }
              : row,
          )
        : kind === "gap"
          ? ledger.filter((_, i) => i !== ledger.length - 2)
          : ledger;
    const report = await auditProductionDatabaseAuthority({
      canonicalClient: client(rows, "12345", kind !== "missing"),
      protectedClient: client(rows, "12345", kind !== "missing"),
      canonicalMigrations: migrations,
    });
    expect(report.pendingMigrationTags).toEqual(
      kind === "current"
        ? { canonical: [], protected: [] }
        : { canonical: null, protected: null },
    );
    expect(report.verdict).toBe(kind === "current" ? "pass" : "fail");
    expect(JSON.stringify(report)).not.toContain("private_invalid_hash");
  }
});

test("mismatched authority and unavailable reports expose no migration plan", async () => {
  const report = await auditProductionDatabaseAuthority({
    canonicalClient: client(ledger.slice(0, -2)),
    protectedClient: client(ledger.slice(0, -2), "67890"),
    canonicalMigrations: migrations,
  });
  expect(report.checks.protectedDatabaseAuthority).toBe("mismatch");
  expect(report.pendingMigrationTags).toEqual({
    canonical: null,
    protected: null,
  });
  expect(unavailableAuditReport().pendingMigrationTags).toEqual({
    canonical: null,
    protected: null,
  });
});

test("ledger divergence reports fixed categories and only uniquely resolved canonical tags", async () => {
  const last = ledger.length - 1;
  const checkpoint = migrations.findIndex(
    (m) => m.entry.tag === "0194_job_execution_interruptions_catalog_guard",
  );
  const cases: {
    reason: MigrationLedgerFailure;
    rows: AppliedMigration[];
    journal?: Migration[];
    tag: string | null;
  }[] = [
    { reason: "too_many_rows", rows: [...ledger, ledger[last]], tag: null },
    {
      reason: "duplicate_journal_time",
      rows: ledger,
      journal: migrations.map((m, i) =>
        i === last
          ? {
              ...m,
              entry: { ...m.entry, when: migrations[last - 1].entry.when },
            }
          : m,
      ),
      tag: null,
    },
    {
      reason: "missing_checkpoint",
      rows: [],
      journal: migrations.filter((_, i) => i !== checkpoint),
      tag: null,
    },
    {
      reason: "invalid_ledger_time",
      rows: ledger.map((r, i) =>
        i === last ? { ...r, created_at: "PRIVATE_INVALID_TIME" } : r,
      ),
      tag: null,
    },
    {
      reason: "duplicate_ledger_time",
      rows: ledger.map((r, i) => (i === last ? ledger[last - 1] : r)),
      tag: null,
    },
    {
      reason: "unmatched_ledger_time",
      rows: ledger.map((r, i) =>
        i === last ? { ...r, created_at: -123456 } : r,
      ),
      tag: null,
    },
    {
      reason: "hash_mismatch",
      rows: ledger.map((r, i) =>
        i === last ? { ...r, hash: "PRIVATE_HASH" } : r,
      ),
      tag: migrations[last].entry.tag,
    },
    {
      reason: "out_of_order",
      rows: [...ledger.slice(0, -2), ledger[last], ledger[last - 1]],
      tag: migrations[last - 1].entry.tag,
    },
    {
      reason: "historical_after_checkpoint",
      rows: [...ledger.slice(checkpoint), ledger[0]],
      tag: migrations[0].entry.tag,
    },
    {
      reason: "missing_required_entry",
      rows: ledger.filter((_, i) => i !== last - 1),
      tag: migrations[last - 1].entry.tag,
    },
  ];
  for (const fixture of cases) {
    const report = await auditProductionDatabaseAuthority({
      canonicalClient: client(fixture.rows),
      protectedClient: client(fixture.rows),
      canonicalMigrations: fixture.journal ?? migrations,
    });
    expect(report.migrationLedgerDiagnostics).toEqual({
      canonical: { reason: fixture.reason, canonicalTag: fixture.tag },
      protected: { reason: fixture.reason, canonicalTag: fixture.tag },
    });
    expect(report.pendingMigrationTags).toEqual({
      canonical: null,
      protected: null,
    });
    expect(report.verdict).toBe("fail");
    for (const raw of [
      "PRIVATE_HASH",
      "PRIVATE_INVALID_TIME",
      "-123456",
      "private_db",
      "private_role",
    ])
      expect(JSON.stringify(report)).not.toContain(raw);
  }
});

test("unknown validation failures stay scrubbed and cannot produce a pending plan", async () => {
  const rows = ledger.map((row) => ({ ...row }));
  Object.defineProperty(rows[0], "created_at", {
    get() {
      throw new Error("PRIVATE_CONNECTION_STRING");
    },
  });
  const report = await auditProductionDatabaseAuthority({
    canonicalClient: client(rows),
    protectedClient: client(rows),
    canonicalMigrations: migrations,
  });
  expect(report.migrationLedgerDiagnostics).toEqual({
    canonical: { reason: "unknown", canonicalTag: null },
    protected: { reason: "unknown", canonicalTag: null },
  });
  expect(report.pendingMigrationTags).toEqual({
    canonical: null,
    protected: null,
  });
  expect(JSON.stringify(report)).not.toContain("PRIVATE_CONNECTION_STRING");
});

test("0387 probe is gated by matching authority and never changes divergent readiness", async () => {
  const rows = ledger.map((row, index) =>
    migrations[index].entry.tag === "0387_agent_compute_funding"
      ? { ...row, hash: "private_unknown_hash" }
      : row,
  );
  for (const matches of [true, false]) {
    const canonicalClient = client(rows);
    const protectedClient = client(rows, matches ? "12345" : "67890");
    const report = await auditProductionDatabaseAuthority({
      canonicalClient,
      protectedClient,
      canonicalMigrations: migrations,
    });
    expect(report.verdict).toBe("fail");
    expect(report.pendingMigrationTags).toEqual({
      canonical: null,
      protected: null,
    });
    expect(
      canonicalClient.queries.some((sql) => sql.startsWith("SELECT hash FROM")),
    ).toBe(matches);
    expect(
      protectedClient.queries.some((sql) => sql.startsWith("SELECT hash FROM")),
    ).toBe(matches);
    if (matches)
      expect(report.funding0387).toEqual({
        canonical: {
          variant: "unknown",
          reason: "ledger_row_count",
          schemaMatches: null,
        },
        protected: {
          variant: "unknown",
          reason: "ledger_row_count",
          schemaMatches: null,
        },
      });
    else
      expect(report.funding0387).toEqual({ canonical: null, protected: null });
    expect(JSON.stringify(report)).not.toContain("private_unknown_hash");
  }
});

test("reports finite actual server major from existing read-only identity queries", async () => {
  for (const [version, expected] of [
    ["180003", "18"],
    ["170009", "other"],
  ] as const) {
    const canonicalClient = client(ledger, "12345", true, version);
    const protectedClient = client(ledger, "12345", true, version);
    const report = await auditProductionDatabaseAuthority({
      canonicalClient,
      protectedClient,
      canonicalMigrations: migrations,
    });
    expect(report.postgresMajor).toEqual({
      canonical: expected,
      protected: expected,
    });
    for (const c of [canonicalClient, protectedClient])
      expect(
        c.queries.filter((query) => query.includes("pg_control_system")),
      ).toHaveLength(1);
    if (expected === "other") expect(report.verdict).toBe("fail");
    expect(JSON.stringify(report)).not.toContain(version);
  }
  expect(unavailableAuditReport().postgresMajor).toEqual({
    canonical: "unavailable",
    protected: "unavailable",
  });
});
