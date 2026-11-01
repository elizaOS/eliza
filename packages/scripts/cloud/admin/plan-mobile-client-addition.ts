/** Add an already approved native app to the protected registry without exporting plaintext. */
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sodium from "libsodium-wrappers";
import pg from "pg";
import { readDatabaseIdentityReceipt } from "../../../cloud/scripts/admin/database-identity-receipt.ts";
import { parseRegisteredMobileClients } from "../../../cloud/shared/src/lib/services/mobile-client-registry.ts";
import {
  type RegistrationRepairClient,
  repairRegistrationTransaction,
  validateRegistrationAuthority,
} from "./repair-mobile-app-auth-registration.ts";
import {
  MOBILE_APP_AUTH_CLIENT_ID,
  MOBILE_APP_AUTH_REDIRECT_URI,
  type MobileAppAuthFetch,
  type MobileAppAuthRegistrationRow,
  type MobileAppAuthRegistrationTarget,
  mobileAppAuthDatabaseConnection,
  PRIMARY_MOBILE_APP_AUTH_TARGET,
  queryMobileAppAuthRegistration,
  resolveMobileAppAuthRegistrationTarget,
  validateMobileAppAuthRegistrationRow,
  verifyLiveMobileAppAuthConfig,
} from "./verify-mobile-app-auth-registration.ts";

const REGISTRY_NAME = "ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON";
const REPOSITORY = "elizaOS/eliza";
const WORKER_ACCOUNT_ID = "23cf6feaeaa541f6a0675053c33da768";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export const REGISTRY_SNAPSHOT_SQL =
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

// Public encryption material read from the owning GitHub environment. A key change
// needs review. Never accept a caller's public key: that would export the registry.
const PRODUCTION_KEY = Object.freeze({
  key_id: "3380204578043523366",
  key: "ZtYTpDp9pOP34tJYPmEX9eIu0i4pOJ8VJLgGL9yEqBs=",
});
const STAGING_KEY = Object.freeze({
  key_id: "3380204578043523366",
  key: "kpWdDmFz4bR6DYsNOze7+eb8eLlBAErj8bDEBEUcEik=",
});

class RegistryError extends Error {
  readonly invariant: string;
  constructor(invariant: string) {
    super(invariant);
    this.invariant = invariant;
  }
}
function fail(invariant: string): never {
  throw new RegistryError(invariant);
}
export const registryDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export interface AdditionInput {
  environment: "staging" | "production";
  clientId: string;
  redirectUri: string;
  registry: string;
  primaryAppId: string;
  intendedAppId?: string;
  organizationId: string;
  ownerUserId: string;
  clusterSha256: string;
  authoritySha256: string;
  displayName?: string;
  provisioningAuthority?: "configured" | "primary";
}
export type AdditionDatabase = RegistrationRepairClient;

/** Private row identity. Only its digest may leave the protected process. */
export interface RegisteredAppBinding {
  appId: string;
  organizationId: string;
  creatorUserId: string | null;
}

export function appBindingDigest(
  input: AdditionInput,
  binding: RegisteredAppBinding,
): string {
  return registryDigest(
    JSON.stringify({
      version: 2,
      environment: input.environment,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      appId: binding.appId,
      organizationId: binding.organizationId,
    }),
  );
}

function targetFor(input: AdditionInput): MobileAppAuthRegistrationTarget {
  if (input.environment !== "production" && input.environment !== "staging")
    fail("environment");
  if (input.clientId === MOBILE_APP_AUTH_CLIENT_ID)
    fail("additional_client_required");
  if (
    !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+$/.test(input.clientId) ||
    input.clientId.length > 200
  )
    fail("client_id");
  let url: URL;
  try {
    url = new URL(input.redirectUri);
  } catch {
    return fail("callback");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== input.redirectUri ||
    input.redirectUri.includes("*") ||
    input.redirectUri.length > 2000
  )
    fail("callback");
  if (!UUID.test(input.primaryAppId)) fail("primary_app_id");
  if (input.intendedAppId && !UUID.test(input.intendedAppId))
    fail("intended_app_id");
  return {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    redirectOrigin: url.origin,
    appName: "Native App",
    appDescription: "Registered native sign-in client",
    slugPrefix: "mobile-auth",
  };
}

async function validateDatabaseIdentity(
  database: AdditionDatabase,
  input: AdditionInput,
): Promise<void> {
  if (!HASH.test(input.clusterSha256) || !HASH.test(input.authoritySha256))
    fail("identity_pin_required");
  const identity = await readDatabaseIdentityReceipt(
    database,
    input.environment,
  );
  if (
    identity.clusterSha256 !== input.clusterSha256 ||
    identity.authoritySha256 !== input.authoritySha256
  )
    fail("identity_mismatch");
}

async function validateApp(
  database: AdditionDatabase,
  appId: string,
  target: MobileAppAuthRegistrationTarget,
): Promise<void> {
  try {
    const registration = await queryMobileAppAuthRegistration(
      async (text, values) => ({
        rows: (await database.query(text, values))
          .rows as unknown as MobileAppAuthRegistrationRow[],
      }),
      appId,
      target,
    );
    validateMobileAppAuthRegistrationRow(registration, appId, target);
  } catch {
    fail("callback_registration_invalid");
  }
}

/** Use operator/registry selection first; callback discovery remains organization-bound. */
export async function discoverRegisteredApp(
  database: AdditionDatabase,
  input: AdditionInput,
): Promise<RegisteredAppBinding> {
  const target = targetFor(input);
  await validateDatabaseIdentity(database, input);
  const registry = parseRegisteredMobileClients(input.registry, {
    clientId: MOBILE_APP_AUTH_CLIENT_ID,
    appId: input.primaryAppId,
    redirectUri: MOBILE_APP_AUTH_REDIRECT_URI,
  });
  if (!registry.ok) fail("source_registry_invalid");
  const registered = registry.registrations.find(
    (entry) => entry.clientId === input.clientId,
  );
  if (
    registered &&
    (!registered.enabled || registered.redirectUri !== input.redirectUri)
  )
    fail("client_already_registered_differently");
  if (
    registered &&
    input.intendedAppId &&
    registered.appId.toLowerCase() !== input.intendedAppId.toLowerCase()
  )
    fail("intended_app_mismatch");
  const selectedAppId = input.intendedAppId || registered?.appId;
  const candidates = await database.query(
    selectedAppId
      ? `SELECT id::text, organization_id::text, created_by_user_id::text
    FROM apps WHERE id=$1::uuid AND is_active = TRUE AND is_approved = TRUE
      AND allowed_origins @> jsonb_build_array($2::text) LIMIT 1`
      : `SELECT id::text, organization_id::text, created_by_user_id::text
    FROM apps WHERE is_active = TRUE AND is_approved = TRUE
      AND allowed_origins @> jsonb_build_array($1::text) LIMIT 2`,
    selectedAppId ? [selectedAppId, target.redirectUri] : [target.redirectUri],
  );
  if (candidates.rows.length === 0) fail("approved_callback_not_found");
  if (candidates.rows.length !== 1) fail("ambiguous_callback");
  const row = candidates.rows[0];
  // App creators can declare their callback metadata, and approval can default
  // to true. Only an operator/registry UUID selects a foreign owner's app;
  // matching callback and approval fields alone do not attest product ownership.
  if (!selectedAppId) {
    if (!UUID.test(input.organizationId)) fail("protected_owner");
    if (row.organization_id !== input.organizationId)
      fail("callback_owner_mismatch");
  }
  if (
    typeof row.id !== "string" ||
    !UUID.test(row.id) ||
    typeof row.organization_id !== "string" ||
    !UUID.test(row.organization_id) ||
    (row.created_by_user_id !== null &&
      (typeof row.created_by_user_id !== "string" ||
        !UUID.test(row.created_by_user_id)))
  )
    fail("callback_app_id");
  await validateApp(database, row.id, target);
  return {
    appId: row.id,
    organizationId: row.organization_id,
    creatorUserId: row.created_by_user_id,
  };
}

/** The returned plaintext stays inside the protected process, never in artifacts or logs. */
export function buildRegistryAddition(input: AdditionInput, appId: string) {
  targetFor(input);
  const reserved = {
    clientId: MOBILE_APP_AUTH_CLIENT_ID,
    appId: input.primaryAppId,
    redirectUri: MOBILE_APP_AUTH_REDIRECT_URI,
  };
  const before = parseRegisteredMobileClients(input.registry, reserved);
  if (!before.ok) fail("source_registry_invalid");
  const existing = before.registrations.find(
    (entry) => entry.clientId === input.clientId,
  );
  if (
    existing &&
    (!existing.enabled ||
      existing.appId.toLowerCase() !== appId.toLowerCase() ||
      existing.redirectUri !== input.redirectUri)
  )
    fail("client_already_registered_differently");
  // Canonical JSON gives the reviewed candidate one exact byte representation,
  // including when the requested registration was already present.
  const candidate = JSON.stringify(
    existing
      ? before.registrations
      : [
          ...before.registrations,
          {
            clientId: input.clientId,
            appId,
            redirectUri: input.redirectUri,
            enabled: true,
          },
        ],
  );
  const after = parseRegisteredMobileClients(candidate, reserved);
  if (!after.ok) fail("candidate_registry_invalid");
  const other = (entries: typeof before.registrations) =>
    JSON.stringify(
      entries.filter((entry) => entry.clientId !== input.clientId),
    );
  if (other(before.registrations) !== other(after.registrations))
    fail("non_target_changed");
  return {
    candidate,
    added: !existing,
    changed: candidate !== input.registry,
    sourceSha256: registryDigest(input.registry),
    candidateSha256: registryDigest(candidate),
    nonTargetSha256: registryDigest(other(before.registrations)),
    appIdSha256: registryDigest(appId),
  };
}

export function trustedGithubKey(repository: string, environment: string) {
  if (repository === REPOSITORY) {
    if (environment === "production") return PRODUCTION_KEY;
    if (environment === "staging") return STAGING_KEY;
  }
  return fail("trusted_github_key_unavailable");
}

/** Export ciphertext to GitHub's key only. The private key never leaves GitHub. */
export async function sealRegistryPlan(
  input: AdditionInput,
  binding: RegisteredAppBinding,
  repository: string,
  sourceCommit: string,
) {
  const publicKey = trustedGithubKey(repository, input.environment);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail("source_commit");
  const { candidate, ...manifest } = buildRegistryAddition(
    input,
    binding.appId,
  );
  await sodium.ready;
  const seal = (value: string) => ({
    key_id: publicKey.key_id,
    encrypted_value: sodium.to_base64(
      sodium.crypto_box_seal(
        sodium.from_string(value),
        sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL),
      ),
      sodium.base64_variants.ORIGINAL,
    ),
  });
  return {
    version: 1,
    repository,
    environment: input.environment,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    sourceCommit,
    secretName: REGISTRY_NAME,
    ...manifest,
    appBindingSha256: appBindingDigest(input, binding),
    requiresCreation: false,
    candidate: seal(candidate),
    rollback: seal(input.registry),
  };
}

export interface ProvisioningExpectation {
  candidateSha256: string;
  nonTargetSha256: string;
  appBindingSha256: string;
  creationSha256: string;
}

function provisioningTarget(
  input: AdditionInput,
): MobileAppAuthRegistrationTarget {
  const target = targetFor(input);
  const origin =
    input.environment === "production"
      ? "https://cloud.eliza.app"
      : "https://cloud-staging.eliza.app";
  if (
    target.redirectOrigin !== origin ||
    !/^\/auth\/[a-z][a-z0-9-]*\/callback$/.test(
      new URL(input.redirectUri).pathname,
    )
  )
    fail("platform_callback");
  if (
    !input.displayName ||
    input.displayName.length > 120 ||
    input.displayName.trim() !== input.displayName ||
    /\p{Cc}/u.test(input.displayName)
  )
    fail("display_name");
  return {
    ...target,
    appName: input.displayName,
    appDescription: "First-party native authentication client",
  };
}

function authorityMode(input: AdditionInput): "configured" | "primary" {
  const mode = input.provisioningAuthority ?? "configured";
  if (mode !== "configured" && mode !== "primary")
    fail("provision_authority_mode");
  return mode;
}

/** Authority selection is explicit; an invalid configured owner never falls back. */
async function platformOwner(database: AdditionDatabase, input: AdditionInput) {
  const mode = authorityMode(input);
  await validateDatabaseIdentity(database, input);
  await validateApp(
    database,
    input.primaryAppId,
    PRIMARY_MOBILE_APP_AUTH_TARGET,
  );
  if (mode === "primary") {
    // This is the exact protected primary UUID, in the same validated snapshot.
    const result = await database.query(
      "SELECT organization_id::text, created_by_user_id::text FROM apps WHERE id=$1::uuid",
      [input.primaryAppId],
    );
    const row = result.rows[0];
    if (
      typeof row?.organization_id !== "string" ||
      !UUID.test(row.organization_id) ||
      typeof row.created_by_user_id !== "string" ||
      !UUID.test(row.created_by_user_id)
    )
      fail("primary_owner");
    await validateRegistrationAuthority(
      database,
      row.organization_id,
      row.created_by_user_id,
    );
    return {
      organizationId: row.organization_id,
      creatorUserId: row.created_by_user_id,
    };
  }
  if (!UUID.test(input.organizationId) || !UUID.test(input.ownerUserId))
    fail("protected_creation_owner_required");
  const organizationId = input.organizationId.toLowerCase();
  const creatorUserId = input.ownerUserId.toLowerCase();
  try {
    await validateRegistrationAuthority(
      database,
      organizationId,
      creatorUserId,
    );
  } catch {
    fail("protected_creation_authority_invalid");
  }
  return { organizationId, creatorUserId };
}

async function provisioningState(
  database: AdditionDatabase,
  input: AdditionInput,
  allowExisting: boolean,
) {
  const target = provisioningTarget(input);
  if (!input.intendedAppId || !UUID.test(input.intendedAppId))
    fail("intended_app_id_required");
  const owner = await platformOwner(database, input);
  const binding = { appId: input.intendedAppId.toLowerCase(), ...owner };
  const plan = buildRegistryAddition(input, binding.appId);
  if (!plan.added) fail("provision_target_already_registered");
  // Include inactive and unapproved claimants: provisioning never adopts a row
  // that a dashboard user created merely because it claims the same callback.
  const claims = await database.query(
    "SELECT id::text FROM apps WHERE allowed_origins @> jsonb_build_array($1::text) LIMIT 2",
    [target.redirectUri],
  );
  if (claims.rows.some((row) => row.id !== binding.appId))
    fail("platform_callback_claimed");
  const existing = await database.query(
    "SELECT organization_id::text, created_by_user_id::text, name, description, slug, app_url FROM apps WHERE id=$1::uuid",
    [binding.appId],
  );
  const row = existing.rows[0];
  if (row) {
    if (!allowExisting) fail("provision_app_already_exists");
    if (
      row.organization_id !== binding.organizationId ||
      row.name !== target.appName ||
      row.description !== target.appDescription ||
      row.slug !== `${target.slugPrefix}-${binding.appId}` ||
      row.app_url !== target.redirectOrigin
    )
      fail("provision_existing_mismatch");
    await validateApp(database, binding.appId, target);
  }
  const appBindingSha256 = appBindingDigest(input, binding);
  const creationSha256 = registryDigest(
    JSON.stringify({
      version: 2,
      authorityMode: authorityMode(input),
      sourceSha256: plan.sourceSha256,
      candidateSha256: plan.candidateSha256,
      nonTargetSha256: plan.nonTargetSha256,
      appBindingSha256,
      creationActorUserId: owner.creatorUserId,
      displayName: target.appName,
      description: target.appDescription,
      slug: `${target.slugPrefix}-${binding.appId}`,
      primaryAppId: input.primaryAppId.toLowerCase(),
      clusterSha256: input.clusterSha256,
      authoritySha256: input.authoritySha256,
    }),
  );
  return {
    binding,
    target,
    plan,
    appBindingSha256,
    creationSha256,
    exists: !!row,
  };
}

/** Prospective only: this plan cannot claim that its new row is already valid. */
export async function planRegistryProvisioning(
  database: AdditionDatabase,
  input: AdditionInput,
  repository: string,
  sourceCommit: string,
) {
  const state = await provisioningState(database, input, false);
  const sealed = await sealRegistryPlan(
    input,
    state.binding,
    repository,
    sourceCommit,
  );
  return {
    ...sealed,
    requiresCreation: true,
    authorityMode: authorityMode(input),
    creationSha256: state.creationSha256,
    displayName: state.target.appName,
  };
}

async function validateProvisioning(
  database: AdditionDatabase,
  input: AdditionInput,
  expected: ProvisioningExpectation,
) {
  if (
    Object.values(expected).length !== 4 ||
    Object.values(expected).some((value) => !HASH.test(value))
  )
    fail("expected_hash_required");
  const state = await provisioningState(database, input, true);
  if (
    state.plan.candidateSha256 !== expected.candidateSha256 ||
    state.plan.nonTargetSha256 !== expected.nonTargetSha256 ||
    state.appBindingSha256 !== expected.appBindingSha256 ||
    state.creationSha256 !== expected.creationSha256
  )
    fail("provision_plan_mismatch");
  return state;
}

/** Create the admitted row only. The old registry stays in GitHub and the Worker. */
export async function provisionRegistry(
  database: RegistrationRepairClient,
  input: AdditionInput,
  expected: ProvisioningExpectation,
): Promise<void> {
  await database.query(REGISTRY_SNAPSHOT_SQL);
  let state: Awaited<ReturnType<typeof validateProvisioning>>;
  try {
    state = await validateProvisioning(database, input, expected);
  } finally {
    await database.query("ROLLBACK");
  }
  await repairRegistrationTransaction(
    database,
    state.binding.appId,
    state.binding.organizationId,
    state.binding.creatorUserId ?? undefined,
    state.target,
    async (locked) => {
      // Repeat every admission after BEGIN SERIALIZABLE and the shared lock,
      // before repair can insert, update, or revoke any generated-key row.
      const admitted = await validateProvisioning(locked, input, expected);
      return admitted.exists ? "unchanged" : undefined;
    },
  );
  await database.query(REGISTRY_SNAPSHOT_SQL);
  try {
    const verified = await validateProvisioning(database, input, expected);
    if (!verified.exists) fail("provisioned_registration_missing");
  } finally {
    await database.query("ROLLBACK");
  }
}

export async function validateRegistryPublication(
  database: AdditionDatabase,
  input: AdditionInput,
  expected: {
    candidateSha256: string;
    nonTargetSha256: string;
    appBindingSha256: string;
  },
) {
  if (
    !HASH.test(expected.candidateSha256) ||
    !HASH.test(expected.nonTargetSha256) ||
    !HASH.test(expected.appBindingSha256)
  )
    fail("expected_hash_required");
  if (registryDigest(input.registry) !== expected.candidateSha256)
    fail("candidate_hash_mismatch");
  const binding = await discoverRegisteredApp(database, input);
  if (appBindingDigest(input, binding) !== expected.appBindingSha256)
    fail("app_binding_mismatch");
  const plan = buildRegistryAddition(input, binding.appId);
  if (plan.added) fail("client_not_in_fresh_registry");
  if (plan.changed) fail("registry_not_canonical");
  if (plan.nonTargetSha256 !== expected.nonTargetSha256)
    fail("non_target_hash_mismatch");
  return targetFor(input);
}

/** Called in a new read-only snapshot; this detects changes, it does not lock owners. */
export async function validatePublishedAppBinding(
  database: AdditionDatabase,
  input: AdditionInput,
  expected: string,
): Promise<void> {
  try {
    if (
      !HASH.test(expected) ||
      appBindingDigest(input, await discoverRegisteredApp(database, input)) !==
        expected
    )
      fail("app_binding_mismatch");
  } catch {
    fail("app_binding_recheck_failed_after_publication");
  }
}

/** Recheck the primary and every enabled source client after the one binding changed. */
export async function verifyPublishedRegistry(
  input: AdditionInput,
  fetchImpl: MobileAppAuthFetch = fetch,
): Promise<number> {
  const registry = parseRegisteredMobileClients(input.registry, {
    clientId: MOBILE_APP_AUTH_CLIENT_ID,
    appId: input.primaryAppId,
    redirectUri: MOBILE_APP_AUTH_REDIRECT_URI,
  });
  if (!registry.ok) fail("source_registry_invalid");
  const clients = [
    MOBILE_APP_AUTH_CLIENT_ID,
    ...registry.registrations
      .filter((entry) => entry.enabled)
      .map((entry) => entry.clientId),
  ];
  try {
    await Promise.all(
      clients.map((clientId) =>
        verifyLiveMobileAppAuthConfig(
          input.environment,
          fetchImpl,
          true,
          resolveMobileAppAuthRegistrationTarget(
            clientId,
            input.environment,
            input.registry,
            input.primaryAppId,
          ),
        ),
      ),
    );
  } catch {
    fail("public_registry_verification_failed_after_publication");
  }
  return clients.length;
}

/** Names-only preflight and one exact secret PUT. No script upload or auto-create. */
export async function publishRegistryBinding(
  input: AdditionInput,
  token: string,
  fetchImpl: MobileAppAuthFetch = fetch,
): Promise<void> {
  const workers = {
    production: "eliza-cloud-api-prod",
    staging: "eliza-cloud-api-staging",
  };
  const worker = workers[input.environment];
  if (!worker || !token) fail("worker_authority");
  const url = `https://api.cloudflare.com/client/v4/accounts/${WORKER_ACCOUNT_ID}/workers/scripts/${worker}/secrets`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  let existing: Response;
  try {
    existing = await fetchImpl(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return fail("worker_preflight_not_confirmed");
  }
  if (existing.status === 404) fail("worker_not_found");
  const inventory = existing.ok
    ? await existing.json().catch(() => null)
    : null;
  if (
    inventory?.success !== true ||
    !Array.isArray(inventory.result) ||
    inventory.result.some(
      (entry: { name?: unknown; type?: unknown } | null) =>
        typeof entry?.name !== "string" || typeof entry?.type !== "string",
    )
  )
    fail("worker_preflight_not_confirmed");
  // Direct API text is exact: no CLI environment suffix or stdin trimming.
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "PUT",
      headers,
      redirect: "error",
      body: JSON.stringify({
        name: REGISTRY_NAME,
        text: input.registry,
        type: "secret_text",
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return fail("worker_registry_publication_not_confirmed");
  }
  const receipt = response.ok ? await response.json().catch(() => null) : null;
  if (
    receipt?.success !== true ||
    receipt.result?.name !== REGISTRY_NAME ||
    receipt.result?.type !== "secret_text"
  )
    fail("worker_registry_publication_not_confirmed");
}

/** All validation must finish before the first Cloudflare request. */
export async function publishValidatedRegistry(
  database: AdditionDatabase,
  input: AdditionInput,
  expected: {
    candidateSha256: string;
    nonTargetSha256: string;
    appBindingSha256: string;
  },
  token: string,
  fetchImpl: MobileAppAuthFetch = fetch,
): Promise<void> {
  await validateRegistryPublication(database, input, expected);
  await publishRegistryBinding(input, token, fetchImpl);
}

function runtimeInput(
  env: NodeJS.ProcessEnv,
  mode: "configured" | "primary",
): AdditionInput {
  const environment = env.ELIZA_MOBILE_APP_AUTH_ENVIRONMENT;
  if (environment !== "staging" && environment !== "production")
    fail("environment");
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REF !==
      `refs/heads/${environment === "production" ? "main" : "staging"}`
  )
    fail("protected_branch");
  return {
    environment,
    clientId: env.ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID ?? "",
    redirectUri: env.ELIZA_MOBILE_APP_AUTH_ADDITION_REDIRECT_URI ?? "",
    registry: env[REGISTRY_NAME] ?? "",
    primaryAppId: env.ELIZA_MOBILE_APP_AUTH_APP_ID ?? "",
    intendedAppId: env.ELIZA_MOBILE_APP_AUTH_INTENDED_APP_ID ?? "",
    organizationId: env.ELIZA_MOBILE_APP_AUTH_ORGANIZATION_ID ?? "",
    ownerUserId: env.ELIZA_MOBILE_APP_AUTH_OWNER_USER_ID ?? "",
    clusterSha256: env.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256 ?? "",
    authoritySha256: env.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256 ?? "",
    displayName: env.ELIZA_MOBILE_APP_AUTH_DISPLAY_NAME ?? "",
    provisioningAuthority: mode,
  };
}

async function main() {
  const operation = process.argv[2];
  if (
    operation !== "plan-addition" &&
    operation !== "publish-registry" &&
    operation !== "plan-provision" &&
    operation !== "provision-registry" &&
    operation !== "plan-provision-primary" &&
    operation !== "provision-primary"
  )
    fail("operation");
  const input = runtimeInput(
    process.env,
    operation === "plan-provision-primary" || operation === "provision-primary"
      ? "primary"
      : "configured",
  );
  trustedGithubKey(process.env.GITHUB_REPOSITORY ?? "", input.environment);
  const { url, ssl } = mobileAppAuthDatabaseConnection(
    process.env.DATABASE_URL ?? "",
  );
  const database = new pg.Client({
    connectionString: url,
    ...(ssl ? { ssl } : {}),
  });
  await database.connect();
  try {
    if (
      operation === "provision-registry" ||
      operation === "provision-primary"
    ) {
      await provisionRegistry(database, input, {
        candidateSha256:
          process.env.ELIZA_MOBILE_APP_AUTH_EXPECTED_REGISTRY_SHA256 ?? "",
        nonTargetSha256:
          process.env.ELIZA_MOBILE_APP_AUTH_EXPECTED_NON_TARGET_SHA256 ?? "",
        appBindingSha256:
          process.env.ELIZA_MOBILE_APP_AUTH_EXPECTED_APP_BINDING_SHA256 ?? "",
        creationSha256:
          process.env.ELIZA_MOBILE_APP_AUTH_EXPECTED_CREATION_SHA256 ?? "",
      });
      console.log(
        JSON.stringify({
          operation,
          environment: input.environment,
          clientId: input.clientId,
          authorityMode: authorityMode(input),
          registrationVerified: true,
          registryPublished: false,
        }),
      );
      return;
    }
    await database.query(REGISTRY_SNAPSHOT_SQL);
    if (
      operation === "plan-addition" ||
      operation === "plan-provision" ||
      operation === "plan-provision-primary"
    ) {
      const repository = process.env.GITHUB_REPOSITORY ?? "";
      const sourceCommit = process.env.GITHUB_SHA ?? "";
      const plan =
        operation !== "plan-addition"
          ? await planRegistryProvisioning(
              database,
              input,
              repository,
              sourceCommit,
            )
          : await sealRegistryPlan(
              input,
              await discoverRegisteredApp(database, input),
              repository,
              sourceCommit,
            );
      const outputRoot = process.env.RUNNER_TEMP;
      if (
        !outputRoot ||
        resolve(outputRoot) !== outputRoot ||
        !process.env.GITHUB_OUTPUT
      )
        fail("artifact_directory");
      const artifact = join(
        outputRoot,
        `mobile-client-addition-${input.environment}.json`,
      );
      writeFileSync(artifact, `${JSON.stringify(plan, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      appendFileSync(process.env.GITHUB_OUTPUT, `artifact_path=${artifact}\n`);
      console.log(
        JSON.stringify({
          operation,
          environment: input.environment,
          clientId: input.clientId,
          sourceSha256: plan.sourceSha256,
          candidateSha256: plan.candidateSha256,
          nonTargetSha256: plan.nonTargetSha256,
          appBindingSha256: plan.appBindingSha256,
          creationSha256:
            "creationSha256" in plan ? plan.creationSha256 : undefined,
          authorityMode:
            "authorityMode" in plan ? plan.authorityMode : undefined,
          requiresCreation: plan.requiresCreation,
          changed: plan.changed,
          plaintextExported: false,
        }),
      );
    } else {
      const expectedAppBindingSha256 =
        process.env.ELIZA_MOBILE_APP_AUTH_EXPECTED_APP_BINDING_SHA256 ?? "";
      if (
        process.env.CLOUDFLARE_ACCOUNT_ID !== WORKER_ACCOUNT_ID ||
        !process.env.CLOUDFLARE_API_TOKEN
      )
        fail("worker_authority");
      await publishValidatedRegistry(
        database,
        input,
        {
          candidateSha256:
            process.env.ELIZA_MOBILE_APP_AUTH_EXPECTED_REGISTRY_SHA256 ?? "",
          nonTargetSha256:
            process.env.ELIZA_MOBILE_APP_AUTH_EXPECTED_NON_TARGET_SHA256 ?? "",
          appBindingSha256: expectedAppBindingSha256,
        },
        process.env.CLOUDFLARE_API_TOKEN,
      );
      console.log(
        JSON.stringify({
          operation,
          environment: input.environment,
          registryPublished: true,
          registrySha256: registryDigest(input.registry),
          publicConfigVerified: false,
        }),
      );
      await database.query("ROLLBACK");
      await database.query(REGISTRY_SNAPSHOT_SQL);
      await validatePublishedAppBinding(
        database,
        input,
        expectedAppBindingSha256,
      );
      const verifiedClients = await verifyPublishedRegistry(input);
      console.log(
        JSON.stringify({
          operation,
          environment: input.environment,
          clientId: input.clientId,
          registrySha256: registryDigest(input.registry),
          publicConfigVerified: true,
          verifiedClients,
          appBindingMatchedAfterPublication: true,
          databaseChanged: false,
        }),
      );
    }
  } finally {
    await database.query("ROLLBACK").catch(() => undefined);
    await database.end();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `[MobileClientRegistry] failed invariant=${error instanceof RegistryError ? error.invariant : "operation_failed"}`,
    );
    process.exitCode = 1;
  });
}
