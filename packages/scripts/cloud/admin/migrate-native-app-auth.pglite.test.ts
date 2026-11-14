import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type MigrationDatabase,
  migrateNativeRegistry,
  nativeRegistryReleaseReady,
  nativeRegistrySnapshot,
  prepareNativeRegistryRelease,
  verifyNativeRegistryMigration,
} from "./migrate-native-app-auth.ts";

const primary = "11111111-1111-4111-8111-111111111111";
const alpha = "22222222-2222-4222-8222-222222222222";
const retired = "33333333-3333-4333-8333-333333333333";
const callback = "https://eliza.app/alphaphone/auth/callback";
const fingerprint = Array(32).fill("AA").join(":");
const identity = {
  clusterSha256: "a".repeat(64),
  authoritySha256: "b".repeat(64),
};
const source = {
  primaryAppId: primary,
  clients: JSON.stringify([
    {
      clientId: "ai.alphacompute.alphaphone",
      appId: alpha,
      redirectUri: callback,
      enabled: true,
    },
    {
      clientId: "ai.elizaresearch.alphaphone",
      appId: alpha,
      redirectUri: callback,
      enabled: true,
      aliasOf: "ai.alphacompute.alphaphone",
    },
    {
      clientId: "org.example.retired",
      appId: retired,
      redirectUri: "https://retired.example/auth/callback",
      enabled: false,
    },
  ]),
  assetLinks: JSON.stringify(
    ["ai.alphacompute.alphaphone", "ai.elizaresearch.alphaphone"].map(
      (package_name) => ({
        package_name,
        sha256_cert_fingerprints: [fingerprint],
      }),
    ),
  ),
  callbacks: JSON.stringify([
    {
      redirectUri: callback,
      androidPackage: "ai.alphacompute.alphaphone",
      appName: "AlphaPhone",
      browserSignIn: {
        startPath: "/alphaphone/browser-start",
        returnPath: "/__alpha/return",
        storageKey: "alpha:pending",
        apiOrigin: "https://api.eliza.app",
        tenant: "elizacloud",
      },
    },
  ]),
};
async function fixture() {
  const pg = new PGlite();
  await pg.exec(
    "CREATE TABLE apps(id uuid PRIMARY KEY, is_active boolean, is_approved boolean, allowed_origins jsonb)",
  );
  for (const [id, url, active] of [
    [primary, "https://eliza.app/auth/callback", true],
    [alpha, callback, true],
    [retired, "https://retired.example/auth/callback", false],
  ] as const) {
    await pg.query("INSERT INTO apps VALUES($1,$2,$2,$3)", [
      id,
      active,
      JSON.stringify([url]),
    ]);
  }
  return { pg, database: pg as unknown as MigrationDatabase };
}

test("imports exact protected registrations, alias assets, browser returns and disabled apps atomically", async () => {
  const { pg, database } = await fixture();
  try {
    const result = await migrateNativeRegistry(database, source, "staging");
    expect(result.clients).toBe(4);
    expect(await migrateNativeRegistry(database, source, "staging")).toEqual(
      result,
    );
    expect(await verifyNativeRegistryMigration(database, "staging")).toEqual(
      result,
    );
    const aliases = await pg.query<{
      callback_android_package: string;
      android_package_name: string;
      browser_sign_in: unknown;
    }>(
      "SELECT callback_android_package,android_package_name,browser_sign_in FROM mobile_app_auth_clients WHERE app_id=$1 ORDER BY client_id",
      [alpha],
    );
    expect(aliases.rows.map((row) => row.android_package_name)).toEqual([
      "ai.alphacompute.alphaphone",
      "ai.elizaresearch.alphaphone",
    ]);
    expect(
      aliases.rows.every(
        (row) => row.callback_android_package === "ai.alphacompute.alphaphone",
      ),
    ).toBe(true);
    expect(aliases.rows[0]?.browser_sign_in).toEqual(
      JSON.parse(source.callbacks)[0].browserSignIn,
    );
    await pg.query("DELETE FROM mobile_app_auth_clients WHERE client_id=$1", [
      "org.example.retired",
    ]);
    await expect(
      verifyNativeRegistryMigration(database, "staging"),
    ).rejects.toThrow("imported_registration_missing");
  } finally {
    await pg.close();
  }
}, 30_000);

test("refuses ambiguous callback ownership before publishing any imported data", async () => {
  const { pg, database } = await fixture();
  try {
    await pg.query("INSERT INTO apps VALUES($1,true,true,$2)", [
      "44444444-4444-4444-8444-444444444444",
      JSON.stringify([callback]),
    ]);
    await expect(
      migrateNativeRegistry(database, source, "production"),
    ).rejects.toThrow("app_binding_not_unique_and_approved");
    expect(
      (
        await pg.query(
          "SELECT to_regclass('mobile_app_auth_clients') AS relation",
        )
      ).rows[0],
    ).toEqual({ relation: null });
  } finally {
    await pg.close();
  }
}, 30_000);

test("rejects partial source associations and refuses to overwrite changed registrations", async () => {
  expect(() =>
    nativeRegistrySnapshot({
      ...source,
      assetLinks: JSON.stringify([
        {
          package_name: "unmatched.example",
          sha256_cert_fingerprints: [fingerprint],
        },
      ]),
    }),
  ).toThrow("unmatched_asset_links");
  const { pg, database } = await fixture();
  try {
    await migrateNativeRegistry(database, source, "production");
    await pg.query(
      "UPDATE mobile_app_auth_clients SET enabled=false WHERE client_id=$1",
      ["ai.alphacompute.alphaphone"],
    );
    await expect(
      migrateNativeRegistry(database, source, "production"),
    ).rejects.toThrow("existing_registration_conflict");
    expect(
      (
        await pg.query(
          "SELECT enabled FROM mobile_app_auth_clients WHERE client_id=$1",
          ["ai.alphacompute.alphaphone"],
        )
      ).rows[0],
    ).toEqual({ enabled: false });
  } finally {
    await pg.close();
  }
}, 30_000);

test("reads complete callback binding from the deployed staging branch across all deployment pages", async () => {
  const { readDeployedNativeCallbacks } = await import(
    "./migrate-native-app-auth.ts"
  );
  const requests: string[] = [];
  const deployment = {
    id: "a1111111",
    project_name: "eliza-app",
    environment: "preview",
    aliases: ["https://staging.eliza-app.pages.dev"],
    deployment_trigger: { metadata: { branch: "staging" } },
    latest_stage: { name: "deploy", status: "success" },
    env_vars: {
      ELIZA_NATIVE_AUTH_CALLBACKS_JSON: {
        type: "plain_text",
        value: source.callbacks,
      },
    },
  };
  const value = await readDeployedNativeCallbacks({
    accountId: "a".repeat(32),
    token: "test-token",
    project: "eliza-app",
    environment: "staging",
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      expect(new URL(url).searchParams.has("per_page")).toBe(false);
      requests.push(url);
      const result = url.endsWith("/eliza-app")
        ? { name: "eliza-app" }
        : new URL(url).searchParams.get("page") === "1"
          ? []
          : new URL(url).searchParams.get("page") === "2"
            ? [deployment]
            : deployment;
      return Response.json({
        success: true,
        result,
        result_info: { total_pages: 2 },
      });
    }) as typeof fetch,
  });
  expect(value).toBe(source.callbacks);
  expect(requests).toHaveLength(4);
});

test("Pages failures report only request stage and numeric provider codes", async () => {
  const { readDeployedNativeCallbacks } = await import(
    "./migrate-native-app-auth.ts"
  );
  await expect(
    readDeployedNativeCallbacks({
      accountId: "a".repeat(32),
      token: "not-logged-token",
      project: "eliza-app",
      environment: "staging",
      fetchImpl: (async (_input: string | URL | Request) =>
        Response.json(
          {
            success: false,
            errors: [{ code: 10000, message: "private provider details" }],
          },
          { status: 400 },
        )) as typeof fetch,
    }),
  ).rejects.toThrow(
    "Native client migration refused: pages_project_http_400_codes_10000",
  );
});

test("release adopts a complete preparation import once and permits later reviewed deletion without legacy source", async () => {
  const { pg, database } = await fixture();
  try {
    await migrateNativeRegistry(database, source, "staging");
    const unavailable = async () => {
      throw new Error("legacy source must not be read");
    };
    expect(
      await prepareNativeRegistryRelease(
        database,
        "staging",
        identity,
        unavailable,
      ),
    ).toEqual({ status: "already_imported" });
    await pg.exec("DELETE FROM mobile_app_auth_clients");
    expect(
      await prepareNativeRegistryRelease(
        database,
        "staging",
        identity,
        unavailable,
      ),
    ).toEqual({ status: "already_imported" });
    expect(
      (
        await pg.query(
          "SELECT count(*)::int AS count FROM mobile_app_auth_clients",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  } finally {
    await pg.close();
  }
}, 30_000);

test("release imports an absent marker from the complete source and fails closed when first source is unavailable", async () => {
  const { pg, database } = await fixture();
  try {
    await migrateNativeRegistry(database, source, "staging");
    await pg.exec(
      "DELETE FROM mobile_app_auth_registry_migrations; DELETE FROM mobile_app_auth_clients;",
    );
    await expect(
      prepareNativeRegistryRelease(database, "staging", identity, async () => {
        throw new Error("source unavailable");
      }),
    ).rejects.toThrow("source unavailable");
    expect(
      await nativeRegistryReleaseReady(database, "staging", identity),
    ).toBe(false);
    expect(
      await prepareNativeRegistryRelease(
        database,
        "staging",
        identity,
        async () => source,
      ),
    ).toMatchObject({ status: "verified", clients: 4 });
    expect(
      await nativeRegistryReleaseReady(database, "staging", identity),
    ).toBe(true);
  } finally {
    await pg.close();
  }
}, 30_000);

test("release refuses a conflicting identity, unsupported marker version, or incompatible schema", async () => {
  const { pg, database } = await fixture();
  try {
    await migrateNativeRegistry(database, source, "production", identity);
    await expect(
      nativeRegistryReleaseReady(database, "production", {
        ...identity,
        clusterSha256: "c".repeat(64),
      }),
    ).rejects.toThrow("migration_identity_conflict");
    await pg.exec(
      "UPDATE mobile_app_auth_registry_migrations SET import_version=2",
    );
    await expect(
      nativeRegistryReleaseReady(database, "production", identity),
    ).rejects.toThrow("migration_marker_invalid");
    await pg.exec(
      "UPDATE mobile_app_auth_registry_migrations SET import_version=1; ALTER TABLE mobile_app_auth_clients DROP COLUMN browser_sign_in",
    );
    await expect(
      nativeRegistryReleaseReady(database, "production", identity),
    ).rejects.toThrow("migration_schema_mismatch");
  } finally {
    await pg.close();
  }
}, 30_000);

test("release refuses to bind a preparation marker after imported rows changed", async () => {
  const { pg, database } = await fixture();
  try {
    await migrateNativeRegistry(database, source, "staging");
    await pg.exec("UPDATE mobile_app_auth_clients SET enabled=false");
    await expect(
      nativeRegistryReleaseReady(database, "staging", identity),
    ).rejects.toThrow("imported_registration_changed");
    expect(
      (
        await pg.query(
          "SELECT cluster_sha256 FROM mobile_app_auth_registry_migrations",
        )
      ).rows,
    ).toEqual([{ cluster_sha256: null }]);
  } finally {
    await pg.close();
  }
}, 30_000);
