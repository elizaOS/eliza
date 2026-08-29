/** Verifies the deterministic, redacted PostgreSQL identity gate with a mocked query boundary. */

import { describe, expect, test } from "bun:test";
import {
  classifyDatabaseIdentityFailure,
  DatabaseIdentityDependencyError,
  databaseIdentityFailureDiagnostic,
  probeDatabaseIdentityDependencies,
  readDatabaseIdentityConfig,
  readDatabaseIdentityReceipt,
  runDatabaseIdentityPreflight,
  runDatabaseIdentityReporter,
} from "./preflight-database-identity";

const row = {
  system_identifier: "7432159876543210000",
  database_name: "staging_database",
  role_name: "staging_role",
  server_version_num: "180002",
};

let observedQuery = "";
const client = {
  query: async (text: string) => {
    observedQuery = text;
    return { rows: [row] };
  },
};

describe("database identity preflight", () => {
  test("is inert by default and requires an explicit environment", () => {
    expect(() => readDatabaseIdentityConfig({})).toThrow(
      "DATABASE_IDENTITY_ENVIRONMENT must be staging or production",
    );
    expect(
      readDatabaseIdentityConfig({ DATABASE_IDENTITY_ENVIRONMENT: "staging" }),
    ).toEqual({
      environment: "staging",
      mode: "off",
      expectedClusterSha256: undefined,
      expectedAuthoritySha256: undefined,
    });
  });

  test("emits stable hashes without raw database identity fields", async () => {
    const receipt = await readDatabaseIdentityReceipt(client, "staging");
    expect(observedQuery).toContain("pg_catalog.pg_control_system()");
    expect(observedQuery).toContain("pg_catalog.current_database()");
    expect(observedQuery).toContain("pg_catalog.current_setting(");
    expect(receipt.postgresMajor).toBe(18);
    expect(receipt.clusterSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.authoritySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(row.system_identifier);
    expect(JSON.stringify(receipt)).not.toContain(row.database_name);
    expect(JSON.stringify(receipt)).not.toContain(row.role_name);
    expect(await readDatabaseIdentityReceipt(client, "staging")).toEqual(
      receipt,
    );
    expect(
      (await readDatabaseIdentityReceipt(client, "production")).authoritySha256,
    ).not.toBe(receipt.authoritySha256);
  });

  test("report mode records mismatch classes without failing", async () => {
    const result = await runDatabaseIdentityPreflight(
      {
        environment: "staging",
        mode: "report",
        expectedClusterSha256: "0".repeat(64),
        expectedAuthoritySha256: "1".repeat(64),
      },
      client,
    );
    expect(result.status).toBe("mismatch");
    expect(result.mismatches).toEqual(["cluster", "authority"]);
  });

  test("report mode never labels an unreviewed receipt as a match", async () => {
    await expect(
      runDatabaseIdentityPreflight(
        { environment: "staging", mode: "report" },
        client,
      ),
    ).resolves.toMatchObject({ status: "reported", mismatches: [] });

    const receipt = await readDatabaseIdentityReceipt(client, "staging");
    await expect(
      runDatabaseIdentityPreflight(
        {
          environment: "staging",
          mode: "report",
          expectedClusterSha256: receipt.clusterSha256,
        },
        client,
      ),
    ).resolves.toMatchObject({ status: "reported", mismatches: [] });
  });

  test("off mode ignores prepared digests without touching the database", async () => {
    const config = readDatabaseIdentityConfig({
      DATABASE_IDENTITY_ENVIRONMENT: "staging",
      DATABASE_IDENTITY_GATE_MODE: "off",
      DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256: "not-a-digest",
      DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256: "also-not-a-digest",
    });
    expect(config).toEqual({
      environment: "staging",
      mode: "off",
      expectedClusterSha256: undefined,
      expectedAuthoritySha256: undefined,
    });
    let queried = false;
    await expect(
      runDatabaseIdentityPreflight(config, {
        query: async () => {
          queried = true;
          throw new Error("query must remain unreachable");
        },
      }),
    ).resolves.toEqual({ status: "disabled", mismatches: [] });
    expect(queried).toBe(false);
  });

  test("report mode ignores malformed expectations and sanitizes query failures", async () => {
    const config = readDatabaseIdentityConfig({
      DATABASE_IDENTITY_ENVIRONMENT: "staging",
      DATABASE_IDENTITY_GATE_MODE: "report",
      DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256: "raw-cluster-identity",
      DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256: "raw-authority-identity",
    });
    expect(config).toEqual({
      environment: "staging",
      mode: "report",
      expectedClusterSha256: undefined,
      expectedAuthoritySha256: undefined,
      ignoredExpectedDigests: ["cluster", "authority"],
    });
    const result = await runDatabaseIdentityPreflight(config, {
      query: async () => {
        throw new Error(
          "connection to raw-host as raw-role for raw-database failed",
        );
      },
    });
    expect(result).toEqual({
      status: "unavailable",
      mismatches: [],
      failureCategory: "database_query_failed",
    });
    expect(JSON.stringify(result)).not.toContain("raw-");
  });

  test("classifies setup failures with a bounded non-sensitive category", () => {
    expect(
      classifyDatabaseIdentityFailure({
        code: "ERR_MODULE_NOT_FOUND",
        message: "missing /private/worktree/packages/prompts/dist/index.js",
      }),
    ).toBe("dependency_unavailable");
    expect(
      classifyDatabaseIdentityFailure({
        code: "ECONNREFUSED",
        message: "connect raw-host as raw-role",
      }),
    ).toBe("database_connection_failed");
    expect(
      classifyDatabaseIdentityFailure(new Error("DATABASE_URL=secret")),
    ).toBe("operator_setup_failed");
    expect(
      JSON.stringify([
        classifyDatabaseIdentityFailure({ code: "ERR_MODULE_NOT_FOUND" }),
        classifyDatabaseIdentityFailure({ code: "ECONNREFUSED" }),
        classifyDatabaseIdentityFailure(new Error("secret")),
      ]),
    ).not.toContain("secret");
  });

  test("probes fixed dependencies in order and reports only the failed label", async () => {
    const observed: string[] = [];
    await probeDatabaseIdentityDependencies(async (specifier) => {
      observed.push(specifier);
      return {};
    });
    expect(observed).toEqual([
      "pg",
      "@elizaos/core/edge",
      "@elizaos/cloud-shared/db/client",
    ]);

    const privateLoaderMessage =
      "Cannot find /private/runner/packages/core/dist/edge/index.edge.js";
    let failure: unknown;
    try {
      await probeDatabaseIdentityDependencies(async (specifier) => {
        if (specifier === "@elizaos/core/edge") {
          throw new Error(privateLoaderMessage);
        }
        return {};
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DatabaseIdentityDependencyError);
    expect(databaseIdentityFailureDiagnostic(failure)).toBe(
      "category=dependency_unavailable; dependency=core_edge",
    );
    expect(databaseIdentityFailureDiagnostic(failure)).not.toContain(
      privateLoaderMessage,
    );
  });

  test("enforce mode requires both authorities and fails closed on mismatch", async () => {
    expect(() =>
      readDatabaseIdentityConfig({
        DATABASE_IDENTITY_ENVIRONMENT: "staging",
        DATABASE_IDENTITY_GATE_MODE: "enforce",
      }),
    ).toThrow("requires both expected database identity SHA-256 digests");

    await expect(
      runDatabaseIdentityPreflight(
        {
          environment: "staging",
          mode: "enforce",
          expectedClusterSha256: "0".repeat(64),
          expectedAuthoritySha256: "1".repeat(64),
        },
        client,
      ),
    ).rejects.toThrow("database identity mismatch: cluster,authority");
  });

  test("enforce mode accepts the exact cluster and authority receipts", async () => {
    const receipt = await readDatabaseIdentityReceipt(client, "staging");
    await expect(
      runDatabaseIdentityPreflight(
        {
          environment: "staging",
          mode: "enforce",
          expectedClusterSha256: receipt.clusterSha256,
          expectedAuthoritySha256: receipt.authoritySha256,
        },
        client,
      ),
    ).resolves.toMatchObject({ status: "match", mismatches: [] });
  });

  test("rejects malformed query rows and authority digests", async () => {
    await expect(
      readDatabaseIdentityReceipt(
        { query: async () => ({ rows: [] }) },
        "staging",
      ),
    ).rejects.toThrow("invalid row");
    expect(() =>
      readDatabaseIdentityConfig({
        DATABASE_IDENTITY_ENVIRONMENT: "staging",
        DATABASE_IDENTITY_GATE_MODE: "enforce",
        DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256: "not-a-digest",
        DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256: "1".repeat(64),
      }),
    ).toThrow("must be a lowercase SHA-256 digest");
  });
});

describe("standalone database identity reporter", () => {
  const reportEnvironment = {
    DATABASE_IDENTITY_ENVIRONMENT: "staging",
    DATABASE_IDENTITY_GATE_MODE: "report",
    DATABASE_URL:
      "postgresql://raw-role:raw-password@raw-host.invalid/raw-database",
  } as const;

  function runtimeClient(
    overrides: {
      connect?: () => Promise<void>;
      end?: () => Promise<void>;
      query?: (text: string) => Promise<{ rows: (typeof row)[] }>;
    } = {},
  ) {
    return {
      connect: overrides.connect ?? (async () => {}),
      end: overrides.end ?? (async () => {}),
      query: overrides.query ?? client.query,
    };
  }

  test("the manual CLI exits nonzero when DATABASE_URL is absent", () => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.DATABASE_URL;
    childEnvironment.DATABASE_IDENTITY_ENVIRONMENT = "staging";
    childEnvironment.DATABASE_IDENTITY_GATE_MODE = "report";
    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        `${import.meta.dir}/preflight-database-identity.ts`,
      ],
      {
        cwd: `${import.meta.dir}/../../../..`,
        env: childEnvironment,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain(
      "database identity report unavailable: DATABASE_URL is missing",
    );
    expect(result.stderr.toString()).toBe("");
  });

  test("connection failures are redacted, nonzero, and close the client", async () => {
    const diagnostics: string[] = [];
    let ended = false;
    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      createClient: async () =>
        runtimeClient({
          connect: async () => {
            throw new Error(
              "connection to raw-host as raw-role for raw-database failed",
            );
          },
          end: async () => {
            ended = true;
          },
        }),
      publishResult: async () => {
        throw new Error("publication must remain unreachable");
      },
      writeStdout: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(1);
    expect(ended).toBe(true);
    expect(diagnostics.join("")).toContain(
      "database identity report unavailable; inspect protected operator logs",
    );
    expect(diagnostics.join("")).not.toMatch(
      /raw-(?:host|role|database)|raw-password/,
    );
  });

  test("an unavailable query status is nonzero without leaking its cause", async () => {
    let publishedStatus = "";
    let ended = false;
    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      createClient: async () =>
        runtimeClient({
          end: async () => {
            ended = true;
          },
          query: async () => {
            throw new Error(
              "query failed on raw-host for raw-role and raw-database",
            );
          },
        }),
      publishResult: async (_config, result) => {
        publishedStatus = JSON.stringify(result);
      },
    });

    expect(exitCode).toBe(1);
    expect(ended).toBe(true);
    expect(publishedStatus).toBe(
      JSON.stringify({ status: "unavailable", mismatches: [] }),
    );
    expect(publishedStatus).not.toContain("raw-");
  });

  test("publication failures are redacted, nonzero, and close the client", async () => {
    const diagnostics: string[] = [];
    let ended = false;
    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      createClient: async () =>
        runtimeClient({
          end: async () => {
            ended = true;
          },
        }),
      publishResult: async () => {
        throw new Error(
          "cannot publish raw-role@raw-host.invalid/raw-database",
        );
      },
      writeStdout: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(1);
    expect(ended).toBe(true);
    expect(diagnostics.join("")).toContain(
      "database identity report unavailable; inspect protected operator logs",
    );
    expect(diagnostics.join("")).not.toMatch(
      /raw-(?:host|role|database)|raw-password/,
    );
  });

  for (const expectedStatus of ["reported", "mismatch"] as const) {
    test(`a published ${expectedStatus} receipt exits successfully`, async () => {
      let publishedStatus = "";
      let ended = false;
      const exitCode = await runDatabaseIdentityReporter(
        {
          ...reportEnvironment,
          ...(expectedStatus === "mismatch"
            ? {
                DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256: "0".repeat(64),
                DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256: "1".repeat(64),
              }
            : {}),
        },
        {
          createClient: async () =>
            runtimeClient({
              end: async () => {
                ended = true;
              },
            }),
          publishResult: async (_config, result) => {
            publishedStatus = result.status;
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(ended).toBe(true);
      expect(publishedStatus).toBe(expectedStatus);
    });
  }
});
