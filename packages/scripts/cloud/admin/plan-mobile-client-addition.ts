/** Add an already approved native app to the protected registry without exporting plaintext. */
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sodium from "libsodium-wrappers";
import pg from "pg";
import { readDatabaseIdentityReceipt } from "../../../cloud/scripts/admin/database-identity-receipt.ts";
import { parseRegisteredMobileClients } from "../../../cloud/shared/src/lib/services/mobile-client-registry.ts";
import {
  MOBILE_APP_AUTH_CLIENT_ID,
  MOBILE_APP_AUTH_REDIRECT_URI,
  type MobileAppAuthFetch,
  type MobileAppAuthRegistrationRow,
  type MobileAppAuthRegistrationTarget,
  mobileAppAuthDatabaseConnection,
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
  organizationId: string;
  ownerUserId: string;
  clusterSha256: string;
  authoritySha256: string;
}
export interface AdditionDatabase {
  query(
    text: string,
    values?: string[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
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
  if (
    ![input.primaryAppId, input.organizationId, input.ownerUserId].every(
      (value) => UUID.test(value),
    )
  )
    fail("protected_owner");
  return {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    redirectOrigin: url.origin,
    appName: "Native App",
    appDescription: "Registered native sign-in client",
    slugPrefix: "mobile-auth",
  };
}

/** Find by callback first: a missing registry must not prevent read-only discovery. */
export async function discoverRegisteredApp(
  database: AdditionDatabase,
  input: AdditionInput,
): Promise<string> {
  const target = targetFor(input);
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
  const candidates = await database.query(
    `SELECT id::text, organization_id::text, created_by_user_id::text
    FROM apps WHERE is_active = TRUE AND is_approved = TRUE
      AND allowed_origins @> jsonb_build_array($1::text) LIMIT 2`,
    [target.redirectUri],
  );
  if (candidates.rows.length === 0) fail("approved_callback_not_found");
  if (candidates.rows.length !== 1) fail("ambiguous_callback");
  const row = candidates.rows[0];
  if (
    row.organization_id !== input.organizationId ||
    row.created_by_user_id !== input.ownerUserId
  )
    fail("callback_owner_mismatch");
  if (typeof row.id !== "string" || !UUID.test(row.id)) fail("callback_app_id");
  try {
    const registration = await queryMobileAppAuthRegistration(
      async (text, values) => ({
        rows: (await database.query(text, values))
          .rows as unknown as MobileAppAuthRegistrationRow[],
      }),
      row.id,
      target,
    );
    validateMobileAppAuthRegistrationRow(registration, row.id, target);
  } catch {
    fail("callback_registration_invalid");
  }
  return row.id;
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
      existing.appId !== appId ||
      existing.redirectUri !== input.redirectUri)
  )
    fail("client_already_registered_differently");
  // Wrangler trims stdin. Canonical JSON makes these the exact published bytes,
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
  if (repository !== REPOSITORY || environment !== "production")
    fail("trusted_github_key_unavailable");
  return PRODUCTION_KEY;
}

/** Export ciphertext to GitHub's key only. The private key never leaves GitHub. */
export async function sealRegistryPlan(
  input: AdditionInput,
  appId: string,
  repository: string,
  sourceCommit: string,
) {
  const publicKey = trustedGithubKey(repository, input.environment);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail("source_commit");
  const { candidate, ...manifest } = buildRegistryAddition(input, appId);
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
    candidate: seal(candidate),
    rollback: seal(input.registry),
  };
}

export async function validateRegistryPublication(
  database: AdditionDatabase,
  input: AdditionInput,
  expected: { candidateSha256: string; nonTargetSha256: string },
) {
  if (
    !HASH.test(expected.candidateSha256) ||
    !HASH.test(expected.nonTargetSha256)
  )
    fail("expected_hash_required");
  if (registryDigest(input.registry) !== expected.candidateSha256)
    fail("candidate_hash_mismatch");
  const appId = await discoverRegisteredApp(database, input);
  const plan = buildRegistryAddition(input, appId);
  if (plan.added) fail("client_not_in_fresh_registry");
  if (plan.changed) fail("registry_not_canonical");
  if (plan.nonTargetSha256 !== expected.nonTargetSha256)
    fail("non_target_hash_mismatch");
  return targetFor(input);
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

function runtimeInput(env: NodeJS.ProcessEnv): AdditionInput {
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
    organizationId: env.ELIZA_MOBILE_APP_AUTH_ORGANIZATION_ID ?? "",
    ownerUserId: env.ELIZA_MOBILE_APP_AUTH_OWNER_USER_ID ?? "",
    clusterSha256: env.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256 ?? "",
    authoritySha256: env.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256 ?? "",
  };
}

async function main() {
  const operation = process.argv[2];
  if (operation !== "plan-addition" && operation !== "publish-registry")
    fail("operation");
  const input = runtimeInput(process.env);
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
    await database.query(REGISTRY_SNAPSHOT_SQL);
    if (operation === "plan-addition") {
      const appId = await discoverRegisteredApp(database, input);
      const plan = await sealRegistryPlan(
        input,
        appId,
        process.env.GITHUB_REPOSITORY ?? "",
        process.env.GITHUB_SHA ?? "",
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
          changed: plan.changed,
          plaintextExported: false,
        }),
      );
    } else {
      await validateRegistryPublication(database, input, {
        candidateSha256:
          process.env.ELIZA_MOBILE_APP_AUTH_EXPECTED_REGISTRY_SHA256 ?? "",
        nonTargetSha256:
          process.env.ELIZA_MOBILE_APP_AUTH_EXPECTED_NON_TARGET_SHA256 ?? "",
      });
      if (
        process.env.CLOUDFLARE_ACCOUNT_ID !== WORKER_ACCOUNT_ID ||
        !process.env.CLOUDFLARE_API_TOKEN
      )
        fail("worker_authority");
      await publishRegistryBinding(input, process.env.CLOUDFLARE_API_TOKEN);
      console.log(
        JSON.stringify({
          operation,
          environment: input.environment,
          registryPublished: true,
          registrySha256: registryDigest(input.registry),
          publicConfigVerified: false,
        }),
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
