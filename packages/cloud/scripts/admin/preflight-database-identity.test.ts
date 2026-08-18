/** Verifies the deterministic, redacted PostgreSQL identity gate with a mocked query boundary. */

import { describe, expect, test } from "bun:test";
import {
  readDatabaseIdentityConfig,
  readDatabaseIdentityReceipt,
  runDatabaseIdentityPreflight,
} from "./preflight-database-identity";

const row = {
  system_identifier: "7432159876543210000",
  database_name: "staging_database",
  role_name: "staging_role",
  server_version_num: "180002",
};

const client = {
  query: async () => ({ rows: [row] }),
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
        DATABASE_IDENTITY_GATE_MODE: "report",
        DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256: "not-a-digest",
      }),
    ).toThrow("must be a lowercase SHA-256 digest");
  });
});
