/** Verifies the deterministic, redacted PostgreSQL identity gate with a mocked query boundary. */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
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

    for (const [failedSpecifier, expectedLabel] of [
      ["pg", "pg"],
      ["@elizaos/core/edge", "core_edge"],
      ["@elizaos/cloud-shared/db/client", "db_client"],
    ] as const) {
      const privateLoaderMessage = `Cannot find /private/runner/${expectedLabel}/dist/index.js`;
      let failure: unknown;
      try {
        await probeDatabaseIdentityDependencies(async (specifier) => {
          if (specifier === failedSpecifier) {
            throw new Error(privateLoaderMessage);
          }
          return {};
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DatabaseIdentityDependencyError);
      expect(databaseIdentityFailureDiagnostic(failure)).toBe(
        `category=dependency_unavailable; dependency=${expectedLabel}`,
      );
      expect(databaseIdentityFailureDiagnostic(failure)).not.toContain(
        privateLoaderMessage,
      );
    }
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
  const noDependencyProbe = async (): Promise<void> => {};

  function runtimeClient(
    overrides: {
      connect?: (events: EventEmitter) => Promise<void>;
      end?: (events: EventEmitter) => Promise<void>;
      query?: (
        text: string,
        events: EventEmitter,
      ) => Promise<{ rows: (typeof row)[] }>;
    } = {},
  ) {
    const events = new EventEmitter();
    return Object.assign(events, {
      connect: async () => {
        await overrides.connect?.(events);
      },
      end: async () => {
        await overrides.end?.(events);
      },
      query: async (text: string) =>
        overrides.query ? overrides.query(text, events) : client.query(text),
    });
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

  test("the dependency-probe CLI flag bypasses reporter configuration", () => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.DATABASE_URL;
    delete childEnvironment.DATABASE_IDENTITY_ENVIRONMENT;
    delete childEnvironment.DATABASE_IDENTITY_GATE_MODE;
    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        `${import.meta.dir}/preflight-database-identity.ts`,
        "--probe-dependencies",
      ],
      {
        cwd: `${import.meta.dir}/../../../..`,
        env: childEnvironment,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      "[database-identity] dependency probes passed: pg,core_edge,db_client\n",
    );
    expect(result.stderr.toString()).toBe("");
  });

  test("a dependency probe failure is bounded and stops before client creation", async () => {
    const diagnostics: string[] = [];
    let clientCreated = false;
    const privateLoaderMessage =
      "Cannot find /private/runner/packages/core/dist/edge/index.edge.js";

    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      probeDependencies: async () => {
        throw Object.assign(new DatabaseIdentityDependencyError("core_edge"), {
          cause: new Error(privateLoaderMessage),
        });
      },
      createClient: async () => {
        clientCreated = true;
        return runtimeClient();
      },
      writeStdout: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(1);
    expect(clientCreated).toBe(false);
    expect(diagnostics.join("")).toContain(
      "database identity report unavailable; category=dependency_unavailable; dependency=core_edge",
    );
    expect(diagnostics.join("")).not.toContain(privateLoaderMessage);
  });

  test("connection failures are redacted, nonzero, and close the client", async () => {
    const diagnostics: string[] = [];
    let ended = false;
    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      probeDependencies: noDependencyProbe,
      createClient: async () =>
        runtimeClient({
          connect: async () => {
            throw Object.assign(
              new Error(
                "connection to raw-host as raw-role for raw-database failed",
              ),
              { code: "ECONNREFUSED" },
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
      "database identity report unavailable; category=database_connection_failed",
    );
    expect(diagnostics.join("")).not.toMatch(
      /raw-(?:host|role|database)|raw-password/,
    );
  });

  test("client error events during a query fail before success publication", async () => {
    const diagnostics: string[] = [];
    const sentinel = "SENSITIVE_DB_EVENT_DETAIL_DURING_QUERY";
    let listenerCountDuringConnect = -1;
    let listenerCountDuringQuery = -1;
    let publishCalls = 0;
    const eventClient = runtimeClient({
      connect: async (events) => {
        listenerCountDuringConnect = events.listenerCount("error");
      },
      query: async (_text, events) => {
        listenerCountDuringQuery = events.listenerCount("error");
        await Promise.resolve();
        events.emit("error", new Error(sentinel));
        events.emit("error", new Error(`${sentinel}_SECOND`));
        return { rows: [row] };
      },
    });
    const initialListenerCount = eventClient.listenerCount("error");

    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      probeDependencies: noDependencyProbe,
      createClient: async () => eventClient,
      publishResult: async () => {
        publishCalls += 1;
      },
      writeStdout: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(1);
    expect(publishCalls).toBe(0);
    expect(listenerCountDuringConnect).toBe(initialListenerCount + 1);
    expect(listenerCountDuringQuery).toBe(initialListenerCount + 1);
    expect(eventClient.listenerCount("error")).toBe(initialListenerCount + 1);
    expect(diagnostics).toEqual([
      "::warning::database identity report unavailable; category=database_connection_failed\n",
    ]);
    expect(diagnostics.join("")).not.toContain(sentinel);
  });

  test("client error events remain bounded through teardown", async () => {
    const diagnostics: string[] = [];
    const sentinel = "SENSITIVE_DB_EVENT_DETAIL_DURING_TEARDOWN";
    let existingListenerCalls = 0;
    let listenerCountAfterFirstEndEvent = -1;
    let listenerCountDuringEnd = -1;
    let publishCalls = 0;
    const eventClient = runtimeClient({
      end: async (events) => {
        listenerCountDuringEnd = events.listenerCount("error");
        await Promise.resolve();
        events.emit("error", new Error(sentinel));
        listenerCountAfterFirstEndEvent = events.listenerCount("error");
        events.emit("error", new Error(`${sentinel}_SECOND`));
      },
    });
    const existingListener = (): void => {
      existingListenerCalls += 1;
    };
    eventClient.on("error", existingListener);
    const initialListenerCount = eventClient.listenerCount("error");

    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      probeDependencies: noDependencyProbe,
      createClient: async () => eventClient,
      publishResult: async () => {
        publishCalls += 1;
      },
      writeStdout: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(1);
    expect(publishCalls).toBe(0);
    expect(existingListenerCalls).toBe(2);
    expect(listenerCountDuringEnd).toBe(initialListenerCount + 1);
    expect(listenerCountAfterFirstEndEvent).toBe(initialListenerCount + 1);
    expect(eventClient.listenerCount("error")).toBe(initialListenerCount + 1);
    expect(diagnostics).toEqual([
      "::warning::database identity report unavailable; category=database_connection_failed\n",
    ]);
    expect(diagnostics.join("")).not.toContain(sentinel);
    eventClient.off("error", existingListener);
  });

  test("client error events queued after close remain bounded before publication", async () => {
    const diagnostics: string[] = [];
    const sentinel = "SENSITIVE_DB_EVENT_DETAIL_AFTER_TEARDOWN";
    let lateEventEmitted = false;
    let publishCalls = 0;
    const eventClient = runtimeClient({
      end: async (events) => {
        setImmediate(() => {
          lateEventEmitted = events.emit("error", new Error(sentinel));
        });
      },
    });
    const initialListenerCount = eventClient.listenerCount("error");

    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      probeDependencies: noDependencyProbe,
      createClient: async () => eventClient,
      publishResult: async () => {
        publishCalls += 1;
      },
      writeStdout: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(1);
    expect(lateEventEmitted).toBe(true);
    expect(publishCalls).toBe(0);
    expect(eventClient.listenerCount("error")).toBe(initialListenerCount + 1);
    expect(diagnostics).toEqual([
      "::warning::database identity report unavailable; category=database_connection_failed\n",
    ]);
    expect(diagnostics.join("")).not.toContain(sentinel);
  });

  test("client error events after publication fail the process boundary", async () => {
    const diagnostics: string[] = [];
    const sentinel = "SENSITIVE_DB_EVENT_DETAIL_AFTER_PUBLICATION";
    let completeLateEvent = (): void => {};
    const lateEvent = new Promise<void>((resolve) => {
      completeLateEvent = resolve;
    });
    let processFailureCalls = 0;
    let publishCalls = 0;
    const eventClient = runtimeClient({
      end: async (events) => {
        setTimeout(() => {
          events.emit("error", new Error(sentinel));
          completeLateEvent();
        }, 30);
      },
    });
    const initialListenerCount = eventClient.listenerCount("error");

    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      probeDependencies: noDependencyProbe,
      createClient: async () => eventClient,
      markProcessFailure: () => {
        processFailureCalls += 1;
      },
      publishResult: async () => {
        publishCalls += 1;
      },
      writeStdout: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(0);
    expect(publishCalls).toBe(1);
    expect(processFailureCalls).toBe(0);
    await lateEvent;
    expect(processFailureCalls).toBe(1);
    expect(eventClient.listenerCount("error")).toBe(initialListenerCount + 1);
    expect(diagnostics).toEqual([
      "::warning::database identity report invalidated; category=database_connection_failed\n",
    ]);
    expect(diagnostics.join("")).not.toContain(sentinel);
  });

  test("a client close rejection fails report mode before publication", async () => {
    const diagnostics: string[] = [];
    const sentinel = "SENSITIVE_DB_CLIENT_CLOSE_DETAIL";
    let publishCalls = 0;
    const eventClient = runtimeClient({
      end: async () => {
        throw new Error(sentinel);
      },
    });
    const initialListenerCount = eventClient.listenerCount("error");

    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      probeDependencies: noDependencyProbe,
      createClient: async () => eventClient,
      publishResult: async () => {
        publishCalls += 1;
      },
      writeStdout: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(1);
    expect(publishCalls).toBe(0);
    expect(eventClient.listenerCount("error")).toBe(initialListenerCount + 1);
    expect(diagnostics).toEqual([
      "::warning::database identity report unavailable; category=database_connection_failed\n",
    ]);
    expect(diagnostics.join("")).not.toContain(sentinel);
  });

  test("a client close rejection fails enforcement with a bounded error", async () => {
    const sentinel = "SENSITIVE_DB_CLIENT_CLOSE_ENFORCE_DETAIL";
    const expectedReceipt = await readDatabaseIdentityReceipt(
      client,
      "staging",
    );
    let publishCalls = 0;
    const eventClient = runtimeClient({
      end: async () => {
        throw new Error(sentinel);
      },
    });
    const initialListenerCount = eventClient.listenerCount("error");
    let failure: unknown;

    try {
      await runDatabaseIdentityReporter(
        {
          ...reportEnvironment,
          DATABASE_IDENTITY_GATE_MODE: "enforce",
          DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256:
            expectedReceipt.clusterSha256,
          DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256:
            expectedReceipt.authoritySha256,
        },
        {
          probeDependencies: noDependencyProbe,
          createClient: async () => eventClient,
          publishResult: async () => {
            publishCalls += 1;
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("database_identity_client_error");
    expect((failure as Error).message).not.toContain(sentinel);
    expect(publishCalls).toBe(0);
    expect(eventClient.listenerCount("error")).toBe(initialListenerCount + 1);
  });

  test("a client close rejection preserves an earlier query failure", async () => {
    const querySentinel = "SENSITIVE_DB_QUERY_PRIMARY_FAILURE";
    const closeSentinel = "SENSITIVE_DB_CLIENT_CLOSE_AFTER_PRIMARY_FAILURE";
    const diagnostics: string[] = [];
    let publishedStatus = "";
    const eventClient = runtimeClient({
      query: async () => {
        throw new Error(querySentinel);
      },
      end: async () => {
        throw new Error(closeSentinel);
      },
    });
    const initialListenerCount = eventClient.listenerCount("error");

    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      probeDependencies: noDependencyProbe,
      createClient: async () => eventClient,
      publishResult: async (_config, result) => {
        publishedStatus = JSON.stringify(result);
      },
      writeStdout: (message) => diagnostics.push(message),
    });

    expect(exitCode).toBe(1);
    expect(publishedStatus).toBe(
      JSON.stringify({
        status: "unavailable",
        mismatches: [],
        failureCategory: "database_query_failed",
      }),
    );
    expect(publishedStatus).not.toContain(querySentinel);
    expect(publishedStatus).not.toContain(closeSentinel);
    expect(diagnostics).toEqual([]);
    expect(eventClient.listenerCount("error")).toBe(initialListenerCount + 1);
  });

  test("an unavailable query status is nonzero without leaking its cause", async () => {
    let publishedStatus = "";
    let ended = false;
    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      probeDependencies: noDependencyProbe,
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
      JSON.stringify({
        status: "unavailable",
        mismatches: [],
        failureCategory: "database_query_failed",
      }),
    );
    expect(publishedStatus).not.toContain("raw-");
  });

  test("publication failures are redacted, nonzero, and close the client", async () => {
    const diagnostics: string[] = [];
    let ended = false;
    const exitCode = await runDatabaseIdentityReporter(reportEnvironment, {
      probeDependencies: noDependencyProbe,
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
      "database identity report unavailable; category=operator_setup_failed",
    );
    expect(diagnostics.join("")).not.toMatch(
      /raw-(?:host|role|database)|raw-password/,
    );
  });

  for (const expectedStatus of ["reported", "mismatch", "match"] as const) {
    test(`a published ${expectedStatus} receipt exits successfully`, async () => {
      let publishedStatus = "";
      let ended = false;
      const expectedReceipt =
        expectedStatus === "match"
          ? await readDatabaseIdentityReceipt(client, "staging")
          : undefined;
      const exitCode = await runDatabaseIdentityReporter(
        {
          ...reportEnvironment,
          ...(expectedStatus === "mismatch"
            ? {
                DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256: "0".repeat(64),
                DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256: "1".repeat(64),
              }
            : expectedReceipt
              ? {
                  DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256:
                    expectedReceipt.clusterSha256,
                  DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256:
                    expectedReceipt.authoritySha256,
                }
              : {}),
        },
        {
          probeDependencies: noDependencyProbe,
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
