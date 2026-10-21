/** Read-only Alpha recovery inventory. Never emit identifiers or provider output. */
import { execFileSync } from "node:child_process";
import pg from "pg";
import { readDatabaseIdentityReceipt } from "../../../cloud/scripts/admin/database-identity-receipt.ts";
import {
  alphaPhoneMobileAppAuthTarget,
  mobileAppAuthDatabaseConnection,
} from "./verify-mobile-app-auth-registration.ts";

const bindings = [
  "ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON",
  "ELIZA_MOBILE_APP_AUTH_APP_ID",
  "ELIZA_ANDROID_ASSET_LINKS_JSON",
] as const;

export async function inventoryRegistration(
  client: pg.Client,
  environment: "staging" | "production",
) {
  for (const name of [
    "ELIZA_MOBILE_APP_AUTH_ORGANIZATION_ID",
    "ELIZA_MOBILE_APP_AUTH_OWNER_USER_ID",
  ]) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        process.env[name] ?? "",
      )
    )
      throw new Error("protected_owner_required");
  }
  const cluster = process.env.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256;
  const authority = process.env.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256;
  if (
    !/^[a-f0-9]{64}$/.test(cluster ?? "") ||
    !/^[a-f0-9]{64}$/.test(authority ?? "")
  )
    throw new Error("identity_pin_required");
  const receipt = await readDatabaseIdentityReceipt(client, environment);
  if (
    receipt.clusterSha256 !== cluster ||
    receipt.authoritySha256 !== authority
  )
    throw new Error("identity_mismatch");
  const result = await client.query(
    `SELECT
    COUNT(*)::integer AS callback_rows,
    COUNT(*) FILTER (WHERE app.is_active AND app.is_approved)::integer AS active_approved_rows,
    COUNT(*) FILTER (WHERE app.organization_id = $2::uuid AND app.created_by_user_id = $3::uuid)::integer AS protected_owner_rows,
    COUNT(*) FILTER (WHERE org.is_active AND owner.is_active AND owner.deleted_at IS NULL
      AND owner.organization_id = org.id AND owner.role IN ('owner', 'admin'))::integer AS valid_owner_rows
    FROM apps app
    LEFT JOIN organizations org ON org.id = app.organization_id
    LEFT JOIN users owner ON owner.id = app.created_by_user_id
    WHERE app.allowed_origins @> jsonb_build_array($1::text)`,
    [
      alphaPhoneMobileAppAuthTarget(environment).redirectUri,
      process.env.ELIZA_MOBILE_APP_AUTH_ORGANIZATION_ID,
      process.env.ELIZA_MOBILE_APP_AUTH_OWNER_USER_ID,
    ],
  );
  return { identityMatched: true, ...result.rows[0] };
}

if (import.meta.main) {
  let client: pg.Client | undefined;
  try {
    const environment = process.env.ELIZA_MOBILE_APP_AUTH_ENVIRONMENT;
    if (environment !== "staging" && environment !== "production")
      throw new Error("environment_required");
    if (
      environment === "production" &&
      process.env.GITHUB_REF !== "refs/heads/main"
    )
      throw new Error("production_main_required");
    // Buffer both streams: Wrangler failures may include operator configuration.
    const output = execFileSync(
      "bunx",
      [
        "wrangler@4.116.0",
        "secret",
        "list",
        "--env",
        environment,
        "--format",
        "json",
      ],
      {
        cwd: "packages/cloud/api",
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const entries: unknown = JSON.parse(output);
    if (
      !Array.isArray(entries) ||
      entries.some((entry) => !entry || typeof entry.name !== "string")
    )
      throw new Error("invalid_inventory");
    const names = new Set(entries.map((entry) => entry.name));
    console.log(
      JSON.stringify({
        workerBindings: Object.fromEntries(
          bindings.map((name) => [name, names.has(name)]),
        ),
      }),
    );
    const { url, ssl } = mobileAppAuthDatabaseConnection(
      process.env.DATABASE_URL ?? "",
    );
    client = new pg.Client({ connectionString: url, ...(ssl ? { ssl } : {}) });
    client.on("error", () => {
      process.exitCode = 1;
    });
    await client.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    console.log(
      JSON.stringify(await inventoryRegistration(client, environment)),
    );
    await client.query("ROLLBACK");
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    console.error(
      [
        "protected_owner_required",
        "identity_pin_required",
        "identity_mismatch",
        "environment_required",
        "production_main_required",
        "invalid_inventory",
      ].includes(code)
        ? `mobile_auth_inventory_${code}`
        : "mobile_auth_inventory_failed",
    );
    process.exitCode = 1;
  } finally {
    try {
      await client?.end();
    } catch {
      process.exitCode = 1;
    }
  }
}
