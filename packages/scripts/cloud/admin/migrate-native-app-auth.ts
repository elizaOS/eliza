/** One-time import of the protected deployment registry before database-only cutover. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import {
  readDatabaseIdentityConfig,
  runDatabaseIdentityPreflight,
} from "../../../cloud/scripts/admin/preflight-database-identity.ts";
import { enforceTlsForRemote } from "../../../cloud/shared/src/db/client.ts";
import { parseAndroidAssetLinksConfig } from "../../../cloud/shared/src/lib/auth/android-asset-links.ts";
import { selectNativeAuthCallback } from "../../../cloud/shared/src/lib/auth/native-auth-callback-config.ts";
import {
  parseRegisteredMobileClients,
  type RegisteredMobileClient,
} from "../../../cloud/shared/src/lib/services/mobile-client-registry.ts";

type Row = Record<string, unknown>;
export interface MigrationDatabase {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
export interface NativeRegistrySource {
  primaryAppId?: string;
  clients?: string;
  assetLinks?: string;
  callbacks?: string;
}
export interface NativeRegistryIdentity {
  clusterSha256: string;
  authoritySha256: string;
}
function refuse(invariant: string): never {
  throw new Error(`Native client migration refused: ${invariant}`);
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const primary = {
  clientId: "ai.elizaos.app",
  redirectUri: "https://eliza.app/auth/callback",
};

export function nativeRegistrySnapshot(source: NativeRegistrySource) {
  if (
    !source.clients?.trim() ||
    !source.assetLinks?.trim() ||
    !source.callbacks?.trim()
  )
    refuse("complete_source_snapshot_required");
  if (!source.primaryAppId || !UUID.test(source.primaryAppId))
    refuse("primary_identity");
  const parsed = parseRegisteredMobileClients(source.clients || "[]", {
    ...primary,
    appId: source.primaryAppId,
  });
  if (!parsed.ok) refuse("registry_invalid");
  const registrations: RegisteredMobileClient[] = [
    ...(source.primaryAppId
      ? [{ ...primary, appId: source.primaryAppId, enabled: true }]
      : []),
    ...parsed.registrations,
  ];
  if (!registrations.length) refuse("empty_registry");
  const assets = parseAndroidAssetLinksConfig(source.assetLinks);
  if (!assets.ok) refuse("asset_links_invalid");
  let callbacks: unknown;
  try {
    callbacks = JSON.parse(source.callbacks || "[]");
  } catch {
    refuse("callbacks_invalid");
  }
  if (!Array.isArray(callbacks)) refuse("callbacks_invalid");
  const records = registrations.map((entry) => {
    const callback = selectNativeAuthCallback(
      source.callbacks || "[]",
      new URL(entry.redirectUri),
    );
    const ownAssets = assets.statements.filter(
      (statement) => statement.target.package_name === entry.clientId,
    );
    if (ownAssets.length > 1) refuse("asset_links_ambiguous");
    return {
      client_id: entry.clientId,
      app_id: entry.appId.toLowerCase(),
      redirect_uri: entry.redirectUri,
      enabled: entry.enabled,
      credential_ttl_seconds: entry.credentialTtlSeconds ?? null,
      android_package_name: ownAssets[0]?.target.package_name ?? null,
      android_cert_fingerprints:
        ownAssets[0]?.target.sha256_cert_fingerprints ?? null,
      android_relations: ownAssets[0]?.relation ?? null,
      callback_android_package: callback?.androidPackage ?? null,
      browser_sign_in: callback?.browserSignIn ?? null,
    };
  });
  // Packages that changed independently of the stable client ID are joined by
  // the protected callback map, never inferred from an app name or an origin.
  for (const asset of assets.statements) {
    if (
      records.some(
        (record) => record.android_package_name === asset.target.package_name,
      )
    )
      continue;
    const candidates = records.filter(
      (record) =>
        record.callback_android_package === asset.target.package_name &&
        !record.android_package_name,
    );
    if (candidates.length !== 1) refuse("unmatched_asset_links");
    Object.assign(candidates[0], {
      android_package_name: asset.target.package_name,
      android_cert_fingerprints: asset.target.sha256_cert_fingerprints,
      android_relations: asset.relation,
    });
  }
  for (const callback of callbacks) {
    if (
      !callback ||
      typeof callback !== "object" ||
      !("redirectUri" in callback) ||
      !records.some((record) => record.redirect_uri === callback.redirectUri)
    )
      refuse("unmatched_callback");
  }
  return records.sort((left, right) =>
    left.client_id.localeCompare(right.client_id),
  );
}

/** Imports all records or none. Existing rows must match exactly; no overwrite path exists. */
export async function migrateNativeRegistry(
  database: MigrationDatabase,
  source: NativeRegistrySource,
  environment: "staging" | "production",
  identity?: NativeRegistryIdentity,
) {
  if (identity) validateIdentity(identity);
  const snapshot = nativeRegistrySnapshot(source);
  await database.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await database.query("SELECT pg_advisory_xact_lock(39257)");
    for (const migration of [
      "0574_native_app_auth_client_registration.sql",
      "0575_native_app_auth_import_identity.sql",
    ]) {
      const sql = await readFile(
        new URL(
          `../../../cloud/shared/src/db/migrations/${migration}`,
          import.meta.url,
        ),
        "utf8",
      );
      for (const statement of sql.split("--> statement-breakpoint"))
        if (statement.trim()) await database.query(statement);
    }
    for (const record of snapshot) {
      const apps = record.enabled
        ? await database.query(
            "SELECT id, is_active, is_approved FROM apps WHERE allowed_origins @> $1::jsonb",
            [JSON.stringify([record.redirect_uri])],
          )
        : await database.query(
            "SELECT id, is_active, is_approved FROM apps WHERE id = $1::uuid",
            [record.app_id],
          );
      if (
        apps.rows.length !== 1 ||
        apps.rows[0]?.id !== record.app_id ||
        (record.enabled &&
          (apps.rows[0]?.is_active !== true ||
            apps.rows[0]?.is_approved !== true))
      )
        refuse("app_binding_not_unique_and_approved");
      await database.query(
        `INSERT INTO mobile_app_auth_clients
        (client_id,app_id,redirect_uri,enabled,credential_ttl_seconds,android_package_name,android_cert_fingerprints,android_relations,callback_android_package,browser_sign_in)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb) ON CONFLICT(client_id) DO NOTHING`,
        [
          record.client_id,
          record.app_id,
          record.redirect_uri,
          record.enabled,
          record.credential_ttl_seconds,
          record.android_package_name,
          JSON.stringify(record.android_cert_fingerprints),
          JSON.stringify(record.android_relations),
          record.callback_android_package,
          JSON.stringify(record.browser_sign_in),
        ],
      );
      const found = await database.query(
        "SELECT client_id,app_id,redirect_uri,enabled,credential_ttl_seconds,android_package_name,android_cert_fingerprints,android_relations,callback_android_package,browser_sign_in FROM mobile_app_auth_clients WHERE client_id=$1",
        [record.client_id],
      );
      if (
        found.rows.length !== 1 ||
        JSON.stringify(found.rows[0]) !== JSON.stringify(record)
      ) {
        // JSONB key ordering is not semantic; compare each structured field canonically.
        if (
          found.rows.length !== 1 ||
          canonical(found.rows[0]) !== canonical(record)
        )
          refuse("existing_registration_conflict");
      }
    }
    const digest = createHash("sha256")
      .update(canonical(snapshot))
      .digest("hex");
    const inventory = await database.query(
      "SELECT count(*)::int AS count FROM mobile_app_auth_clients",
    );
    if (inventory.rows[0]?.count !== snapshot.length)
      refuse("unexpected_database_registration");
    const prior = await database.query(
      "SELECT source_digest, client_count FROM mobile_app_auth_registry_migrations WHERE environment=$1",
      [environment],
    );
    if (
      prior.rows.length &&
      (prior.rows[0]?.source_digest !== digest ||
        prior.rows[0]?.client_count !== snapshot.length)
    )
      refuse("migration_source_conflict");
    await database.query(
      "INSERT INTO mobile_app_auth_registry_migrations(environment, source_digest, client_count, client_ids) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(environment) DO NOTHING",
      [
        environment,
        digest,
        snapshot.length,
        JSON.stringify(snapshot.map((record) => record.client_id)),
      ],
    );
    if (identity) await bindMigrationIdentity(database, environment, identity);
    await database.query("COMMIT");
    return { clients: snapshot.length, digest };
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
}

function validateIdentity(identity: NativeRegistryIdentity) {
  if (
    !/^[0-9a-f]{64}$/.test(identity.clusterSha256) ||
    !/^[0-9a-f]{64}$/.test(identity.authoritySha256)
  )
    refuse("migration_identity_invalid");
}

async function bindMigrationIdentity(
  database: MigrationDatabase,
  environment: "staging" | "production",
  identity: NativeRegistryIdentity,
) {
  const result = await database.query(
    `UPDATE mobile_app_auth_registry_migrations SET cluster_sha256=$2, authority_sha256=$3
     WHERE environment=$1 AND import_version=1 AND schema_version=574
     AND (cluster_sha256 IS NULL OR cluster_sha256=$2)
     AND (authority_sha256 IS NULL OR authority_sha256=$3)
     RETURNING environment`,
    [environment, identity.clusterSha256, identity.authoritySha256],
  );
  if (result.rows.length !== 1) refuse("migration_identity_conflict");
}

/** The release cutover trusts only an identity-bound, versioned completion marker.
 * It never requires the original clients to remain after that cutover. */
export async function nativeRegistryReleaseReady(
  database: MigrationDatabase,
  environment: "staging" | "production",
  identity: NativeRegistryIdentity,
): Promise<boolean> {
  validateIdentity(identity);
  const columns = await database.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='mobile_app_auth_clients'`,
  );
  const required: Record<string, [string, string]> = {
    client_id: ["text", "NO"],
    app_id: ["uuid", "NO"],
    redirect_uri: ["text", "NO"],
    credential_ttl_seconds: ["integer", "YES"],
    android_package_name: ["text", "YES"],
    callback_android_package: ["text", "YES"],
    android_relations: ["jsonb", "YES"],
    android_cert_fingerprints: ["jsonb", "YES"],
    browser_sign_in: ["jsonb", "YES"],
    enabled: ["boolean", "NO"],
  };
  if (
    Object.entries(required).some(
      ([name, [type, nullable]]) =>
        !columns.rows.some(
          (column) =>
            column.column_name === name &&
            column.data_type === type &&
            column.is_nullable === nullable,
        ),
    )
  )
    refuse("migration_schema_mismatch");
  const result = await database.query(
    "SELECT environment,import_version,schema_version,cluster_sha256,authority_sha256,source_digest,client_count,client_ids,completed_at FROM mobile_app_auth_registry_migrations WHERE environment=$1",
    [environment],
  );
  if (!result.rows.length) return false;
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.environment !== environment ||
    row.import_version !== 1 ||
    row.schema_version !== 574 ||
    typeof row.source_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.source_digest) ||
    !Number.isInteger(row.client_count) ||
    Number(row.client_count) < 1 ||
    !Array.isArray(row.client_ids) ||
    row.client_ids.length !== row.client_count ||
    new Set(row.client_ids).size !== row.client_ids.length ||
    row.client_ids.some((id) => typeof id !== "string" || !id) ||
    !row.completed_at
  )
    refuse("migration_marker_invalid");
  if (row.cluster_sha256 === null && row.authority_sha256 === null) {
    // Preparation imports predate the identity columns. Bind them once only
    // after exact readback, under the same serialization lock as the importer.
    await database.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      await database.query("SELECT pg_advisory_xact_lock(39257)");
      await verifyNativeRegistryMigration(database, environment);
      await bindMigrationIdentity(database, environment, identity);
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }
  } else if (
    row.cluster_sha256 !== identity.clusterSha256 ||
    row.authority_sha256 !== identity.authoritySha256
  )
    refuse("migration_identity_conflict");
  return true;
}

/** Called only between canonical schema migration and runtime activation. */
export async function prepareNativeRegistryRelease(
  database: MigrationDatabase,
  environment: "staging" | "production",
  identity: NativeRegistryIdentity,
  readSource: () => Promise<NativeRegistrySource>,
) {
  if (await nativeRegistryReleaseReady(database, environment, identity))
    return { status: "already_imported" as const };
  const result = await migrateNativeRegistry(
    database,
    await readSource(),
    environment,
    identity,
  );
  await verifyNativeRegistryMigration(database, environment);
  return { status: "verified" as const, ...result };
}

export async function verifyNativeRegistryMigration(
  database: MigrationDatabase,
  environment: "staging" | "production",
) {
  const result = await database.query(
    "SELECT source_digest, client_count, client_ids FROM mobile_app_auth_registry_migrations WHERE environment=$1",
    [environment],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    typeof row.source_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.source_digest) ||
    typeof row.client_count !== "number" ||
    row.client_count < 1
  )
    refuse("complete_import_required");
  if (
    !Array.isArray(row.client_ids) ||
    row.client_ids.length !== row.client_count ||
    row.client_ids.some((id) => typeof id !== "string")
  )
    refuse("complete_import_required");
  const retained = await database.query(
    "SELECT count(*)::int AS count FROM mobile_app_auth_clients WHERE client_id = ANY($1::text[])",
    [row.client_ids],
  );
  if (retained.rows[0]?.count !== row.client_count)
    refuse("imported_registration_missing");
  const rows = await database.query(
    "SELECT client_id,app_id,redirect_uri,enabled,credential_ttl_seconds,android_package_name,android_cert_fingerprints,android_relations,callback_android_package,browser_sign_in FROM mobile_app_auth_clients WHERE client_id = ANY($1::text[]) ORDER BY client_id",
    [row.client_ids],
  );
  if (
    createHash("sha256").update(canonical(rows.rows)).digest("hex") !==
    row.source_digest
  )
    refuse("imported_registration_changed");
  return { clients: row.client_count, digest: row.source_digest };
}

/** Reads the complete callback binding of the deployed canonical Pages branch. */
export async function readDeployedNativeCallbacks(input: {
  accountId: string;
  token: string;
  project: string;
  environment: "staging" | "production";
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (
    !/^[0-9a-f]{32}$/.test(input.accountId) ||
    !/^[a-z0-9-]+$/.test(input.project) ||
    !input.token
  )
    refuse("pages_credentials");
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/pages/projects/${input.project}`;
  const object = (value: unknown): Row => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      refuse("pages_response");
    return value as Row;
  };
  const read = async (stage: "project" | "list" | "detail", url: string) => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${input.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return refuse(`pages_${stage}_transport`);
    }
    const payload = object(await response.json());
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const codes = errors
      .map((error) =>
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined,
      )
      .filter((code) => Number.isSafeInteger(code));
    if (!response.ok || payload.success !== true)
      refuse(
        `pages_${stage}_http_${response.status}${codes.length ? `_codes_${codes.join("_")}` : ""}`,
      );
    return payload;
  };
  const project = object((await read("project", base)).result);
  const branch = input.environment === "production" ? "main" : "staging";
  const environment =
    input.environment === "production" ? "production" : "preview";
  let selected: Row;
  if (input.environment === "production")
    selected = object(project.canonical_deployment);
  else {
    const matches: Row[] = [];
    for (let page = 1; ; page++) {
      const payload = await read(
        "list",
        `${base}/deployments?env=preview&page=${page}`,
      );
      if (!Array.isArray(payload.result)) refuse("pages_deployments");
      for (const value of payload.result) {
        const deployment = object(value);
        const metadata = object(object(deployment.deployment_trigger).metadata);
        if (
          metadata.branch === branch &&
          deployment.environment === environment &&
          Array.isArray(deployment.aliases) &&
          deployment.aliases.includes(
            `https://staging.${input.project}.pages.dev`,
          )
        )
          matches.push(deployment);
      }
      const info = object(payload.result_info);
      if (
        typeof info.total_pages !== "number" ||
        !Number.isInteger(info.total_pages)
      )
        refuse("pages_pagination");
      if (page >= info.total_pages) break;
    }
    if (matches.length !== 1 || !matches[0])
      refuse("pages_current_branch_ambiguous");
    selected = matches[0];
  }
  if (typeof selected.id !== "string" || !/^[a-z0-9-]+$/i.test(selected.id))
    refuse("pages_deployment_identity");
  const deployed = object(
    (await read("detail", `${base}/deployments/${selected.id}`)).result,
  );
  const metadata = object(object(deployed.deployment_trigger).metadata);
  const stage = object(deployed.latest_stage);
  if (
    deployed.id !== selected.id ||
    deployed.project_name !== input.project ||
    deployed.environment !== environment ||
    metadata.branch !== branch ||
    stage.name !== "deploy" ||
    stage.status !== "success" ||
    (input.environment === "staging" &&
      (!Array.isArray(deployed.aliases) ||
        !deployed.aliases.includes(
          `https://staging.${input.project}.pages.dev`,
        )))
  )
    refuse("pages_deployment_identity");
  const binding = object(
    object(deployed.env_vars).ELIZA_NATIVE_AUTH_CALLBACKS_JSON,
  );
  if (
    binding.type !== "plain_text" ||
    typeof binding.value !== "string" ||
    !binding.value.trim()
  )
    refuse("pages_callback_binding_unreadable");
  // The parser validates every entry, even if no callback is selected here.
  selectNativeAuthCallback(
    binding.value,
    new URL("https://unmatched.invalid/"),
  );
  return binding.value;
}

if (import.meta.main) {
  let database: Client | undefined;
  try {
    const environment = process.env.ENVIRONMENT;
    if (
      !process.env.DATABASE_URL ||
      (environment !== "staging" && environment !== "production")
    )
      refuse("environment");
    const { url, ssl } = enforceTlsForRemote(process.env.DATABASE_URL);
    database = new Client({
      connectionString: url,
      ...(ssl ? { ssl } : {}),
      connectionTimeoutMillis: 10_000,
    });
    await database.connect();
    const identity = readDatabaseIdentityConfig({
      ...process.env,
      DATABASE_IDENTITY_GATE_MODE: "enforce",
      DATABASE_IDENTITY_ENVIRONMENT: environment,
    });
    await runDatabaseIdentityPreflight(identity, database);
    const verifiedIdentity = {
      clusterSha256: identity.expectedClusterSha256 ?? "",
      authoritySha256: identity.expectedAuthoritySha256 ?? "",
    };
    const readSource = async (): Promise<NativeRegistrySource> => ({
      primaryAppId: process.env.ELIZA_MOBILE_APP_AUTH_APP_ID,
      clients: process.env.ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON,
      assetLinks: process.env.ELIZA_ANDROID_ASSET_LINKS_JSON,
      callbacks:
        process.env.ELIZA_NATIVE_AUTH_CALLBACKS_JSON?.trim() ||
        (await readDeployedNativeCallbacks({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
          token: process.env.CLOUDFLARE_API_TOKEN ?? "",
          project: process.env.PAGES_PROJECT ?? "eliza-app",
          environment,
        })),
    });
    // Reuse the canonical production effect gate immediately before BEGIN.
    // The gate verifies exact main source and tree-bound staging evidence; a
    // branch name or database identity alone cannot authorize this mutation.
    if (environment === "production" && !process.argv.includes("--verify")) {
      const root = path.resolve(import.meta.dirname, "../../../..");
      execFileSync(
        process.execPath,
        [
          "--conditions=eliza-source",
          path.join(
            root,
            "packages/cloud/scripts/production-effect-certification.ts",
          ),
          process.env.GITHUB_SHA ?? "",
        ],
        { cwd: root, env: process.env, stdio: "inherit", timeout: 180_000 },
      );
    }
    const result = process.argv.includes("--verify")
      ? await verifyNativeRegistryMigration(database, environment)
      : process.argv.includes("--release")
        ? await prepareNativeRegistryRelease(
            database,
            environment,
            verifiedIdentity,
            readSource,
          )
        : await migrateNativeRegistry(
            database,
            await readSource(),
            environment,
            verifiedIdentity,
          );
    console.log(JSON.stringify({ status: "verified", ...result }));
  } catch (error) {
    console.error(
      error instanceof Error &&
        error.message.startsWith("Native client migration refused:")
        ? error.message
        : "Native client migration failed; no credentials or registry data logged",
    );
    process.exitCode = 1;
  } finally {
    await database?.end();
  }
}
