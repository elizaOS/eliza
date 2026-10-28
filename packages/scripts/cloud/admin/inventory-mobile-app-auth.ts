/** Read-only registered-client recovery tooling. Never emit row IDs, credentials or provider output. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";
import { readDatabaseIdentityReceipt } from "../../../cloud/scripts/admin/database-identity-receipt.ts";
import {
  parseRegisteredMobileClients,
  planRegisteredMobileClientAppIdUpdate,
} from "../../../cloud/shared/src/lib/services/mobile-client-registry.ts";
import {
  MOBILE_APP_AUTH_CLIENT_ID,
  MOBILE_APP_AUTH_REDIRECT_URI,
  mobileAppAuthDatabaseConnection,
  PRIMARY_MOBILE_APP_AUTH_TARGET,
  queryMobileAppAuthRegistration,
  requireMobileAppAuthAppId,
  resolveMobileAppAuthRegistrationSelection,
  resolveMobileAppAuthRegistrationTarget,
  validateMobileAppAuthRegistrationRow,
} from "./verify-mobile-app-auth-registration.ts";

const bindings = [
  "ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON",
  "ELIZA_MOBILE_APP_AUTH_APP_ID",
  "ELIZA_ANDROID_ASSET_LINKS_JSON",
] as const;

async function admitInventoryDatabase(
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
}

export async function compareClientAuthority(
  client: pg.Client,
  environment: "staging" | "production",
) {
  const { target, appId } = resolveMobileAppAuthRegistrationSelection(
    process.env.ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID,
    environment,
    process.env.ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON,
    process.env.ELIZA_MOBILE_APP_AUTH_APP_ID,
  );
  await admitInventoryDatabase(client, environment);
  const result = await client.query(
    `SELECT
    app.id IS NOT NULL AS app_exists,
    COALESCE(app.is_active AND app.is_approved, FALSE) AS app_active_approved,
    COALESCE(org.is_active, FALSE) AS organization_active,
    COALESCE(owner.is_active AND owner.deleted_at IS NULL, FALSE) AS owner_active,
    COALESCE(owner.organization_id = org.id AND owner.role IN ('owner', 'admin'), FALSE) AS owner_authorized,
    COALESCE(app.organization_id = $2::uuid, FALSE) AS protected_organization_matches,
    COALESCE(app.created_by_user_id = $3::uuid, FALSE) AS protected_owner_matches
    FROM (SELECT $1::uuid AS id) requested
    LEFT JOIN apps app ON app.id = requested.id
    LEFT JOIN organizations org ON org.id = app.organization_id
    LEFT JOIN users owner ON owner.id = app.created_by_user_id`,
    [
      appId,
      process.env.ELIZA_MOBILE_APP_AUTH_ORGANIZATION_ID,
      process.env.ELIZA_MOBILE_APP_AUTH_OWNER_USER_ID,
    ],
  );
  // Protected owner matches are diagnostic baseline comparisons, not approval
  // or a claim that every additional client must share the primary owner.
  return {
    identityMatched: true,
    liveWorkerCompared: false,
    clientId: target.clientId,
    ...result.rows[0],
  };
}

export async function inventoryRegistration(
  client: pg.Client,
  environment: "staging" | "production",
) {
  await admitInventoryDatabase(client, environment);
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
      resolveMobileAppAuthRegistrationTarget(
        process.env.ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID,
        environment,
        process.env.ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON,
        process.env.ELIZA_MOBILE_APP_AUTH_APP_ID,
      ).redirectUri,
      process.env.ELIZA_MOBILE_APP_AUTH_ORGANIZATION_ID,
      process.env.ELIZA_MOBILE_APP_AUTH_OWNER_USER_ID,
    ],
  );
  return { identityMatched: true, ...result.rows[0] };
}

/** Source-only plan; caller must separately prove/fence any live publication. */
export async function planClientRegistryUpdate(
  client: pg.Client,
  environment: "staging" | "production",
  intendedAppId: unknown,
) {
  const { target } = resolveMobileAppAuthRegistrationSelection(
    process.env.ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID,
    environment,
    process.env.ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON,
    process.env.ELIZA_MOBILE_APP_AUTH_APP_ID,
  );
  if (target === PRIMARY_MOBILE_APP_AUTH_TARGET)
    throw new Error("additional_client_required");
  const appId = requireMobileAppAuthAppId(intendedAppId);
  await admitInventoryDatabase(client, environment);
  const row = await queryMobileAppAuthRegistration(
    (text, values) => client.query(text, values),
    appId,
    target,
  );
  validateMobileAppAuthRegistrationRow(row, appId, target);
  return planRegisteredMobileClientAppIdUpdate(
    process.env.ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON,
    target.clientId,
    appId,
    {
      clientId: MOBILE_APP_AUTH_CLIENT_ID,
      appId: process.env.ELIZA_MOBILE_APP_AUTH_APP_ID,
      redirectUri: MOBILE_APP_AUTH_REDIRECT_URI,
    },
  );
}

/** A primary-only legacy operation must never silently inspect another client. */
export function requireMobileAuthInventoryOperation(
  value: unknown,
  clientId: unknown,
): "inventory" | "compare-primary" | "compare-client" | "plan-client" {
  if (
    value !== "inventory" &&
    value !== "compare-primary" &&
    value !== "compare-client" &&
    value !== "plan-client"
  )
    throw new Error("operation_required");
  if (
    value === "compare-primary" &&
    clientId !== undefined &&
    clientId !== "" &&
    clientId !== MOBILE_APP_AUTH_CLIENT_ID
  )
    throw new Error("primary_comparison_requires_primary_client");
  return value;
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
    const operation = requireMobileAuthInventoryOperation(
      process.env.ELIZA_MOBILE_APP_AUTH_INVENTORY_OPERATION ?? "inventory",
      process.env.ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID,
    );
    if (operation !== "plan-client") {
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
    }
    const { url, ssl } = mobileAppAuthDatabaseConnection(
      process.env.DATABASE_URL ?? "",
    );
    client = new pg.Client({ connectionString: url, ...(ssl ? { ssl } : {}) });
    client.on("error", () => {
      process.exitCode = 1;
    });
    await client.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    if (operation === "plan-client") {
      const plan = await planClientRegistryUpdate(
        client,
        environment,
        process.env.ELIZA_MOBILE_APP_AUTH_INTENDED_APP_ID,
      );
      if (!plan.ok) throw new Error("registry_plan_rejected");
      const source = process.env.ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON ?? "";
      const reserved = {
        clientId: MOBILE_APP_AUTH_CLIENT_ID,
        appId: process.env.ELIZA_MOBILE_APP_AUTH_APP_ID,
        redirectUri: MOBILE_APP_AUTH_REDIRECT_URI,
      };
      const before = parseRegisteredMobileClients(source, reserved);
      const after = parseRegisteredMobileClients(plan.registryJson, reserved);
      if (!before.ok || !after.ok) throw new Error("registry_plan_rejected");
      const nonTarget = (entries: typeof before.registrations) =>
        JSON.stringify(
          entries.filter(
            (entry) =>
              entry.clientId !==
              process.env.ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID,
          ),
        );
      if (nonTarget(before.registrations) !== nonTarget(after.registrations))
        throw new Error("registry_plan_rejected");
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      console.log(
        JSON.stringify({
          sourceOnly: true,
          liveWorkerCompared: false,
          changed: plan.changed,
          clientId: process.env.ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID,
          sourceSha256: digest(source),
          candidateSha256: digest(plan.registryJson),
          nonTargetSourceSha256: digest(nonTarget(before.registrations)),
        }),
      );
    } else {
      console.log(
        JSON.stringify(
          await (operation === "inventory"
            ? inventoryRegistration(client, environment)
            : compareClientAuthority(client, environment)),
        ),
      );
    }
    await client.query("ROLLBACK");
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    console.error(
      [
        "protected_owner_required",
        "primary_app_required",
        "primary_comparison_requires_primary_client",
        "additional_client_required",
        "registry_plan_rejected",
        "operation_required",
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
