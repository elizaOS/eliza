/** Protected native publisher provisioning. Never copies a user's tenant or credentials. */
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AdditionDatabase,
  type AdditionInput,
  appBindingDigest,
  buildRegistryAddition,
  platformOwner,
  provisioningTarget,
  REGISTRY_SNAPSHOT_SQL,
  RegistryError,
  registryDigest,
  sealRegistryPlan,
  validateDatabaseIdentity,
} from "./plan-mobile-client-addition.ts";
import {
  type MobileAppAuthRegistrationRow,
  queryMobileAppAuthRegistration,
  resolveMobileAppAuthRegistrationSelection,
  validateMobileAppAuthRegistrationRow,
} from "./verify-mobile-app-auth-registration.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const RECEIPT = "nativeAppPublisherIsolation";
type Mode = "provision" | "isolate";
export interface PublisherExpectation {
  candidateSha256: string;
  nonTargetSha256: string;
  appBindingSha256: string;
  creationSha256: string;
}
function fail(invariant: string): never {
  // Do not expose UUIDs, registry text, operator identities, or database errors.
  throw new RegistryError(`publisher_${invariant}`);
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

function selectedInput(input: AdditionInput, mode: Mode): AdditionInput {
  if (mode === "provision") {
    if (!input.intendedAppId || !UUID.test(input.intendedAppId))
      fail("intended_app_required");
    return input;
  }
  const selection = resolveMobileAppAuthRegistrationSelection(
    input.clientId,
    input.environment,
    input.registry,
    input.primaryAppId,
  );
  if (
    input.intendedAppId &&
    input.intendedAppId.toLowerCase() !== selection.appId.toLowerCase()
  )
    fail("registered_app_mismatch");
  if (selection.target.redirectUri !== input.redirectUri)
    fail("registered_callback_mismatch");
  return { ...input, intendedAppId: selection.appId };
}

async function verifyRegistration(
  database: AdditionDatabase,
  input: AdditionInput,
  strict: boolean,
) {
  const target = provisioningTarget(input);
  if (!input.intendedAppId || !UUID.test(input.intendedAppId))
    fail("intended_app_required");
  const appId = input.intendedAppId;
  try {
    const row = await queryMobileAppAuthRegistration(
      async (sql, values) => ({
        rows: (await database.query(sql, values))
          .rows as unknown as MobileAppAuthRegistrationRow[],
      }),
      appId,
      target,
    );
    validateMobileAppAuthRegistrationRow(row, appId, target, {
      requirePublisher: strict,
    });
  } catch {
    fail("registration_invalid");
  }
}

/** Reject any app-owned workload; only customer consent/grants survive the move. */
async function registrationOnly(
  database: AdditionDatabase,
  app: Record<string, unknown>,
  lockResources: boolean,
) {
  if (
    app.deployment_status !== "draft" ||
    app.production_url != null ||
    app.last_deployed_at != null ||
    app.github_repo != null ||
    app.monetization_enabled !== false ||
    app.custom_pricing_enabled === true ||
    app.affiliate_code != null ||
    [
      "inference_markup_percentage",
      "purchase_share_percentage",
      "platform_offset_amount",
      "total_creator_earnings",
      "total_platform_revenue",
      "total_credits_used",
      "referral_bonus_credits",
    ].some((key) => Number(app[key] ?? 0) !== 0) ||
    ["discord_automation", "telegram_automation", "twitter_automation"].some(
      (key) => record(app[key]).enabled === true,
    ) ||
    (Array.isArray(app.linked_character_ids) &&
      app.linked_character_ids.length !== 0) ||
    (Array.isArray(app.promotional_assets) &&
      app.promotional_assets.length !== 0)
  )
    fail("not_registration_only");
  const metadata = record(app.metadata);
  if (Object.keys(metadata).some((key) => key !== RECEIPT))
    fail("app_metadata_not_empty");
  // Catalog-derived identifiers are quoted, never supplied by workflow input.
  // Include non-FK app_id columns too: billing ledgers deliberately retain IDs.
  const columns = await database.query<{
    schema_name: string;
    table_name: string;
    column_name: string;
  }>(`
    SELECT n.nspname AS schema_name,c.relname AS table_name,a.attname AS column_name
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
       AND a.attname='app_id' AND a.atttypid='uuid'::regtype
       AND c.relname NOT IN ('app_users','mobile_app_auth_grants')
     ORDER BY n.nspname,c.relname,a.attname`);
  for (const column of columns.rows) {
    if (lockResources)
      await database.query(
        `LOCK TABLE ${quote(column.schema_name)}.${quote(column.table_name)} IN SHARE MODE`,
      );
    const found = await database.query(
      `SELECT 1 FROM ${quote(column.schema_name)}.${quote(column.table_name)} WHERE ${quote(column.column_name)}=$1::uuid LIMIT 1`,
      [app.id],
    );
    if (found.rows.length) fail("app_resources_exist");
  }
}

async function state(
  database: AdditionDatabase,
  input: AdditionInput,
  mode: Mode,
  lockResources = false,
) {
  input = selectedInput(input, mode);
  await validateDatabaseIdentity(database, input);
  const target = provisioningTarget(input);
  if (
    !input.intendedAppId ||
    !UUID.test(input.intendedAppId) ||
    !input.publisherOrganizationId ||
    !UUID.test(input.publisherOrganizationId)
  )
    fail("publisher_identity_required");
  const appId = input.intendedAppId.toLowerCase();
  const organizationId = input.publisherOrganizationId.toLowerCase();
  // The active primary operator is an audit/authorization anchor only. Neither
  // that user's personal organization nor their key becomes the publisher.
  const operator = await platformOwner(database, {
    ...input,
    provisioningAuthority: "primary",
  });
  if (organizationId === operator.organizationId)
    fail("cannot_copy_operator_organization");
  const orgResult = await database.query<{
    organization: unknown;
    registered: boolean;
    members: number;
  }>(
    `
    SELECT to_jsonb(o) AS organization,p.organization_id IS NOT NULL AS registered,
      (SELECT count(*)::integer FROM users u WHERE u.organization_id=o.id) AS members
      FROM organizations o LEFT JOIN native_app_publishers p ON p.organization_id=o.id WHERE o.id=$1::uuid`,
    [organizationId],
  );
  const existingOrg = orgResult.rows[0];
  if (
    existingOrg &&
    (!existingOrg.registered ||
      existingOrg.members !== 0 ||
      record(existingOrg.organization).is_active !== true ||
      record(existingOrg.organization).account_lifecycle_state !== "active")
  )
    fail("destination_not_active_memberless_publisher");
  const result = await database.query<{ app: unknown }>(
    "SELECT to_jsonb(a) AS app FROM apps a WHERE id=$1::uuid",
    [appId],
  );
  const app = result.rows[0] ? record(result.rows[0].app) : null;
  const receipt = record(record(app?.metadata)[RECEIPT]);
  const completed =
    !!app &&
    app.organization_id === organizationId &&
    receipt.mode === mode &&
    typeof receipt.sourceBindingSha256 === "string" &&
    HASH.test(receipt.sourceBindingSha256);
  if (app) {
    if (mode === "provision" && !completed) fail("fresh_app_already_exists");
    await registrationOnly(database, app, lockResources);
    await verifyRegistration(database, input, completed);
    if (completed && (!existingOrg || app.api_key_id !== null))
      fail("completed_state_changed");
  } else if (mode === "isolate") fail("registered_app_missing");
  const registry = buildRegistryAddition(input, appId);
  if (
    (mode === "isolate" && registry.added) ||
    (mode === "provision" && !registry.added)
  )
    fail("registry_mode_mismatch");
  let legacyKey: unknown = null;
  if (app?.api_key_id) {
    const key = await database.query<{ key: unknown }>(
      "SELECT to_jsonb(k) AS key FROM api_keys k WHERE id=$1::uuid",
      [app.api_key_id],
    );
    legacyKey = key.rows[0]?.key ?? null;
    const row = record(legacyKey);
    if (
      legacyKey &&
      (row.is_active !== false ||
        row.deleted_at == null ||
        row.organization_id !== app.organization_id)
    )
      fail("legacy_key_not_revoked_or_wrong_owner");
  }
  const sourceBindingSha256 = completed
    ? (receipt.sourceBindingSha256 as string)
    : registryDigest(JSON.stringify({ app, legacyKey }));
  const binding = {
    appId,
    organizationId,
    creatorUserId:
      mode === "provision" ? null : (app?.created_by_user_id as string | null),
  };
  const appBindingSha256 = appBindingDigest(input, binding);
  const creationSha256 = registryDigest(
    JSON.stringify({
      version: 1,
      mode,
      sourceBindingSha256,
      appBindingSha256,
      sourceSha256: registry.sourceSha256,
      candidateSha256: registry.candidateSha256,
      nonTargetSha256: registry.nonTargetSha256,
      displayName: target.appName,
      operatorUserId: operator.creatorUserId,
      primaryAppId: input.primaryAppId,
      clusterSha256: input.clusterSha256,
      authoritySha256: input.authoritySha256,
    }),
  );
  if (completed && receipt.creationSha256 !== creationSha256)
    fail("completed_plan_mismatch");
  return {
    binding,
    target,
    registry,
    creationSha256,
    sourceBindingSha256,
    appBindingSha256,
    completed,
    existingOrg,
  };
}

export async function planPublisherRegistration(
  database: AdditionDatabase,
  input: AdditionInput,
  mode: Mode,
  repository: string,
  sourceCommit: string,
) {
  if (repository !== "elizaOS/eliza" || !/^[a-f0-9]{40}$/.test(sourceCommit))
    fail("reviewed_source_required");
  input = selectedInput(input, mode);
  const planned = await state(database, input, mode);
  const publicPlan = {
    version: 1,
    mode,
    environment: input.environment,
    sourceSha256: planned.registry.sourceSha256,
    candidateSha256: planned.registry.candidateSha256,
    nonTargetSha256: planned.registry.nonTargetSha256,
    appBindingSha256: planned.appBindingSha256,
    creationSha256: planned.creationSha256,
    registryChanged: mode === "provision",
    publisherVerified: !!planned.existingOrg,
    requiresPublisherCreation: !planned.existingOrg,
    requiresAppCreation: mode === "provision" && !planned.completed,
    requiresCreation: mode === "provision" && !planned.completed,
    repository,
    sourceCommit,
  };
  return mode === "provision"
    ? {
        ...(await sealRegistryPlan(
          input,
          planned.binding,
          repository,
          sourceCommit,
        )),
        ...publicPlan,
      }
    : publicPlan;
}

function matches(
  planned: Awaited<ReturnType<typeof state>>,
  expected: PublisherExpectation,
) {
  if (
    Object.values(expected).some((value) => !HASH.test(value)) ||
    planned.registry.candidateSha256 !== expected.candidateSha256 ||
    planned.registry.nonTargetSha256 !== expected.nonTargetSha256 ||
    planned.appBindingSha256 !== expected.appBindingSha256 ||
    planned.creationSha256 !== expected.creationSha256
  )
    fail("reviewed_plan_mismatch");
}

export async function applyPublisherRegistration(
  database: AdditionDatabase,
  input: AdditionInput,
  mode: Mode,
  expected: PublisherExpectation,
): Promise<void> {
  input = selectedInput(input, mode);
  await database.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await database.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "eliza-mobile-app-auth-registration",
    ]);
    await database.query(
      "SELECT id FROM apps WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [[input.primaryAppId, input.intendedAppId]],
    );
    await database.query(
      "SELECT id FROM organizations WHERE id=$1::uuid OR id IN (SELECT organization_id FROM apps WHERE id=ANY($2::uuid[])) ORDER BY id FOR UPDATE",
      [
        input.publisherOrganizationId,
        [input.primaryAppId, input.intendedAppId],
      ],
    );
    await database.query(
      "SELECT organization_id FROM native_app_publishers WHERE organization_id=$1::uuid FOR UPDATE",
      [input.publisherOrganizationId],
    );
    await database.query(
      "SELECT id FROM api_keys WHERE id IN (SELECT api_key_id FROM apps WHERE id=ANY($1::uuid[])) ORDER BY id FOR UPDATE",
      [[input.primaryAppId, input.intendedAppId]],
    );
    await database.query(
      "SELECT u.id FROM users u JOIN apps a ON a.created_by_user_id=u.id WHERE a.id=$1::uuid FOR UPDATE OF u",
      [input.primaryAppId],
    );
    const planned = await state(database, input, mode, true);
    matches(planned, expected);
    if (!planned.completed) {
      if (!planned.existingOrg) {
        await database.query(
          "INSERT INTO organizations(id,name,slug) VALUES($1::uuid,'Native app publisher',$2)",
          [
            planned.binding.organizationId,
            `native-app-publisher-${planned.binding.organizationId}`,
          ],
        );
        await database.query(
          "INSERT INTO native_app_publishers(organization_id) VALUES($1::uuid)",
          [planned.binding.organizationId],
        );
      }
      const receipt = {
        [RECEIPT]: {
          version: 1,
          mode,
          sourceBindingSha256: planned.sourceBindingSha256,
          creationSha256: planned.creationSha256,
        },
      };
      if (mode === "provision") {
        await database.query(
          `INSERT INTO apps(id,name,description,slug,organization_id,created_by_user_id,app_url,allowed_origins,api_key_id,is_active,is_approved,metadata)
          VALUES($1::uuid,$2,$3,$4,$5::uuid,NULL,$6,jsonb_build_array($7::text),NULL,TRUE,TRUE,$8::jsonb)`,
          [
            planned.binding.appId,
            planned.target.appName,
            planned.target.appDescription,
            `${planned.target.slugPrefix}-${planned.binding.appId}`,
            planned.binding.organizationId,
            planned.target.redirectOrigin,
            planned.target.redirectUri,
            JSON.stringify(receipt),
          ],
        );
      } else {
        // Preserve historical creator audit and all customer consent/grant IDs.
        // Detach the revoked legacy key; never modify or move its credential row.
        await database.query(
          "UPDATE apps SET organization_id=$2::uuid,api_key_id=NULL,metadata=metadata || $3::jsonb,updated_at=NOW() WHERE id=$1::uuid",
          [
            planned.binding.appId,
            planned.binding.organizationId,
            JSON.stringify(receipt),
          ],
        );
      }
    }
    const verified = await state(database, input, mode);
    matches(verified, expected);
    if (!verified.completed) fail("post_write_verification");
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK").catch(() => undefined);
    if (error instanceof RegistryError) throw error;
    fail("transaction_failed");
  }
}

export async function runPublisherOperation(
  database: AdditionDatabase,
  input: AdditionInput,
  operation: string,
  env: NodeJS.ProcessEnv,
) {
  if (operation === "verify-publisher") {
    input = selectedInput(input, "isolate");
    await database.query(REGISTRY_SNAPSHOT_SQL);
    await validateDatabaseIdentity(database, input);
    if (
      !input.publisherOrganizationId ||
      !UUID.test(input.publisherOrganizationId)
    )
      fail("publisher_identity_required");
    await verifyRegistration(database, input, true);
    const result = await database.query(
      "SELECT organization_id::text FROM apps WHERE id=$1::uuid",
      [input.intendedAppId],
    );
    if (
      result.rows[0]?.organization_id !==
      input.publisherOrganizationId.toLowerCase()
    )
      fail("verified_destination_mismatch");
    console.log(
      JSON.stringify({
        operation,
        environment: input.environment,
        publisherVerified: true,
      }),
    );
    return;
  }
  const mode = operation.includes("isolate") ? "isolate" : "provision";
  if (operation.startsWith("plan-")) {
    await database.query(REGISTRY_SNAPSHOT_SQL);
    const planned = await planPublisherRegistration(
      database,
      input,
      mode,
      env.GITHUB_REPOSITORY ?? "",
      env.GITHUB_SHA ?? "",
    );
    const root = env.RUNNER_TEMP;
    if (!root || resolve(root) !== root || !env.GITHUB_OUTPUT)
      fail("artifact_directory");
    const artifact = join(root, `mobile-publisher-${input.environment}.json`);
    writeFileSync(artifact, `${JSON.stringify(planned, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    appendFileSync(env.GITHUB_OUTPUT, `artifact_path=${artifact}\n`);
    console.log(
      JSON.stringify({
        operation,
        environment: input.environment,
        candidateSha256: planned.candidateSha256,
        nonTargetSha256: planned.nonTargetSha256,
        appBindingSha256: planned.appBindingSha256,
        creationSha256: planned.creationSha256,
      }),
    );
  } else {
    await applyPublisherRegistration(database, input, mode, {
      candidateSha256: env.ELIZA_MOBILE_APP_AUTH_EXPECTED_REGISTRY_SHA256 ?? "",
      nonTargetSha256:
        env.ELIZA_MOBILE_APP_AUTH_EXPECTED_NON_TARGET_SHA256 ?? "",
      appBindingSha256:
        env.ELIZA_MOBILE_APP_AUTH_EXPECTED_APP_BINDING_SHA256 ?? "",
      creationSha256: env.ELIZA_MOBILE_APP_AUTH_EXPECTED_CREATION_SHA256 ?? "",
    });
    console.log(
      JSON.stringify({
        operation,
        environment: input.environment,
        publisherVerified: true,
        registryPublished: false,
      }),
    );
  }
}
