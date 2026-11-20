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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function includesId(list: string | undefined, id: string): boolean {
  return (list ?? "").toLowerCase().split(/[\s,]+/).includes(id.toLowerCase());
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

  let apiKeyId: string;
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await assertStagingDatabaseIdentity(client);
    const hash = createHash("sha256").update(fixtureKey).digest("hex");
    const { rows } = await client.query<{ id: string }>(
      `SELECT id
      FROM api_keys
      WHERE key_hash = $1 AND user_id = $2 AND organization_id = $3
        AND is_active = TRUE AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))`,
      [hash, userId, organizationId],
    );
    if (rows.length !== 1 || !UUID.test(rows[0].id)) {
      throw new Error("exact_active_fixture_unresolved");
    }
    apiKeyId = rows[0].id;
  } finally {
    await client.end();
  }

  const rows = [
    ["API key id", apiKeyId, process.env.ALLOWED_API_KEY_IDS],
    ["User id", userId, process.env.ALLOWED_USER_IDS],
    ["Organization id", organizationId, process.env.ALLOWED_ORGANIZATION_IDS],
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
