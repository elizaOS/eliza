/** Resolve only the protected staging fixture credential in a read-only transaction. */
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { Client } from "pg";
import { createRuntimePgClient } from "./preflight-database-identity";
import {
  assertStagingDatabaseIdentity,
  assertStagingOperatorEnvironment,
} from "./staging-database-identity-pin";

const STAGING_API = "https://api-staging.eliza.app";
// The staging Worker deployment supplies this same Steward tenant.
const STAGING_STEWARD_TENANT = "elizacloud-staging";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function includesId(list: string | undefined, id: string): boolean {
  return (list ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .includes(id.toLowerCase());
}

async function main() {
  assertStagingOperatorEnvironment();
  const fixtureKey = process.env.ELIZAOS_CLOUD_API_KEY?.trim();
  const databaseUrl = process.env.DATABASE_URL;
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "elizaOS/eliza" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !fixtureKey ||
    !/^eliza_[0-9a-f]{64}$/.test(fixtureKey) ||
    !databaseUrl
  ) {
    throw new Error("protected_fixture_admission");
  }

  const response = await fetch(`${STAGING_API}/api/v1/user`, {
    headers: { Authorization: `Bearer ${fixtureKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("staging_api_identity_unavailable");
  const body = await response.json();
  const user = body.data ?? body;
  const userId = user.id;
  const organizationId = user.organization?.id ?? user.organization_id;
  if (
    typeof userId !== "string" ||
    typeof organizationId !== "string" ||
    !UUID.test(userId) ||
    !UUID.test(organizationId)
  ) {
    throw new Error("staging_api_identity_invalid");
  }

  // The existing factory configures and returns a node-postgres Client.
  const client = (await createRuntimePgClient(databaseUrl)) as Client;
  client.on("error", () => {
    process.exitCode = 1;
  });

  type FixtureIdentity = {
    id: string;
    app_key: boolean;
    sandbox_key: boolean;
    active_user: boolean;
    active_organization: boolean;
    ordinary_steward_user: boolean;
    matching_steward_identity: boolean;
    assigned_tenant: boolean;
    staging_tenant: boolean;
  };
  let fixture: FixtureIdentity;
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await assertStagingDatabaseIdentity(client);
    const hash = createHash("sha256").update(fixtureKey).digest("hex");
    const { rows } = await client.query<FixtureIdentity>(
      `SELECT key.id,
        EXISTS (SELECT 1 FROM apps app WHERE app.api_key_id = key.id) AS app_key,
        key.name LIKE 'agent-sandbox:%' AS sandbox_key,
        COALESCE(cloud_user.is_active AND NOT cloud_user.is_anonymous
          AND cloud_user.deleted_at IS NULL
          AND (cloud_user.expires_at IS NULL OR cloud_user.expires_at > CURRENT_TIMESTAMP)
          AND cloud_user.organization_id = key.organization_id, FALSE) AS active_user,
        COALESCE(org.is_active, FALSE) AS active_organization,
        COALESCE(btrim(cloud_user.steward_user_id) <> ''
          AND btrim(cloud_user.steward_user_id)
            !~ '^(system:|anonymous:|affiliate:|wallet:|email:|telegram:|discord:|phone:|whatsapp:|svc_)',
          FALSE) AS ordinary_steward_user,
        EXISTS (SELECT 1 FROM user_identities identity
          WHERE identity.steward_user_id = btrim(cloud_user.steward_user_id)
            AND identity.user_id = cloud_user.id) AS matching_steward_identity,
        COALESCE(btrim(org.steward_tenant_id) <> '', FALSE) AS assigned_tenant,
        COALESCE(btrim(org.steward_tenant_id) = $4, FALSE) AS staging_tenant
      FROM api_keys key
      LEFT JOIN users cloud_user ON cloud_user.id = key.user_id
      LEFT JOIN organizations org ON org.id = cloud_user.organization_id
      WHERE key.key_hash = $1 AND key.user_id = $2 AND key.organization_id = $3
        AND key.is_active = TRUE AND key.deleted_at IS NULL
        AND (key.expires_at IS NULL OR key.expires_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))`,
      [hash, userId, organizationId, STAGING_STEWARD_TENANT],
    );
    if (rows.length !== 1 || !UUID.test(rows[0].id)) {
      throw new Error("exact_active_fixture_unresolved");
    }
    fixture = rows[0];
  } finally {
    await client.end();
  }

  const rows = [
    ["API key id", fixture.id, process.env.ALLOWED_API_KEY_IDS],
    ["User id", userId, process.env.ALLOWED_USER_IDS],
    ["Organization id", organizationId, process.env.ALLOWED_ORGANIZATION_IDS],
  ] as const;
  const checks = [
    ["App credential", fixture.app_key],
    ["Sandbox credential", fixture.sandbox_key],
    ["Active registered Cloud user", fixture.active_user],
    ["Active organization", fixture.active_organization],
    ["Ordinary Steward user", fixture.ordinary_steward_user],
    ["Matching Steward identity", fixture.matching_steward_identity],
    ["Assigned Steward tenant", fixture.assigned_tenant],
    ["Matches staging Steward tenant", fixture.staging_tenant],
  ] as const;
  const output = [
    "## Staging API key identity",
    "",
    "| Field | Value | In allowlist |",
    "|---|---|---|",
    ...rows.map(
      ([label, id, allowlist]) =>
        `| ${label} | ${id} | ${includesId(allowlist, id) ? "allowed" : "NOT-ALLOWED"} |`,
    ),
    "",
    "| Subject predicate | Observed |",
    "|---|---|",
    ...checks.map(([label, value]) => `| ${label} | ${value} |`),
    "",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, output, "utf8");
  }
  process.stdout.write(output);
}

await main().catch(() => {
  // Raw HTTP, configuration and PostgreSQL failures can include authority details.
  process.stderr.write(
    "::error::Protected staging credential identity could not be verified\n",
  );
  process.exitCode = 1;
});
