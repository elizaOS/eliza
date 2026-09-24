/** Resolves native product selections to current purchaser identity and server-owned developer funding without exposing infrastructure credentials. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { eq } from "drizzle-orm";
import { decryptApiKey } from "../../db/crypto/api-keys";
import { dbWrite } from "../../db/helpers";
import { apiKeysRepository } from "../../db/repositories/api-keys";
import { resolveAppBillingApplicationSlot } from "../../db/repositories/app-billing-application-slots";
import type { ApiKey } from "../../db/schemas/api-keys";
import { apps } from "../../db/schemas/apps";
import type { AppContext } from "../../types/cloud-worker-env";
import { verifyStewardTokenCached } from "../auth/steward-client";
import { readStewardSessionToken, requireUserOrApiKey } from "../auth/workers-hono-auth";
import {
  type AppInferenceDelegatedActor,
  appInferenceErrorResponse,
} from "./app-subscription-inference-admission";
import {
  assertInferenceCredentialActive,
  type InferenceCredentialCheck,
} from "./inference-credential-revocation";

function deny(code: string, message: string): never {
  throw new ElizaError(message, { code: `APP_INFERENCE_${code}` });
}
function hash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
function activeKey(key: ApiKey | undefined): key is ApiKey {
  return Boolean(
    key &&
      key.is_active &&
      !key.deleted_at &&
      (!key.expires_at || key.expires_at.getTime() > Date.now()),
  );
}

/** Preserves ordinary requests; selected requests carry only a server-resolved developer credential into canonical model admission. */
export async function prepareNativeApplicationInference(
  c: AppContext,
  request: Request = c.req.raw,
): Promise<{ request: Request; actor: AppInferenceDelegatedActor | undefined }> {
  const slotKey = c.req.header("X-Eliza-Application-Slot");
  if (slotKey === undefined) return { request, actor: undefined };
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(slotKey) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(c.req.header("Idempotency-Key") ?? "")
  )
    deny("REQUEST", "Provide a configured application product and stable operation ID");
  for (const name of [
    "X-App-Id",
    "X-Affiliate-Code",
    "X-App-Delegation",
    "X-Eliza-Developer-Authorization",
    "X-Eliza-Billing-Account-Id",
    "X-Eliza-Product-Family",
  ])
    if (c.req.header(name))
      deny(
        "REQUEST",
        "Native product selection cannot be combined with app billing credentials or attribution",
      );
  const environment = c.env.APP_INFERENCE_EXECUTION_ENVIRONMENT;
  if (environment !== "test" && environment !== "live")
    deny("PROJECTION_UNAVAILABLE", "Application inference execution environment is not configured");
  const bearer = c.req.header("Authorization");
  const bearerKey = bearer?.startsWith("Bearer eliza_") ? bearer.substring(7) : null;
  const headerKey = c.req.header("X-API-Key");
  if (headerKey && bearer && bearer !== `Bearer ${headerKey}`)
    deny("REQUEST", "Conflicting native credentials");
  const rawKey = headerKey ?? bearerKey;
  const sessionToken = rawKey ? null : readStewardSessionToken(c);
  if (!rawKey && !sessionToken) deny("NATIVE_CREDENTIAL", "A native user credential is required");
  const user = await requireUserOrApiKey(c);
  if (!user.is_active || user.is_anonymous || !user.organization_id)
    deny("NATIVE_CREDENTIAL", "A current native account is required");
  const organizationId = user.organization_id;
  const selectionInput = { slotKey, livemode: environment === "live", verifiedUserId: user.id };
  const selection = await resolveAppBillingApplicationSlot(selectionInput);
  let nativeCredential: InferenceCredentialCheck;
  let originalKeyId: string | null = null;
  if (rawKey) {
    const key = await apiKeysRepository.findByHashConsistent(hash(rawKey));
    if (
      !activeKey(key) ||
      key.user_id !== user.id ||
      key.organization_id !== organizationId ||
      (key.source_app_id !== null && key.source_app_id !== selection.appId)
    )
      deny("NATIVE_CREDENTIAL", "Native credential is no longer authorized for this application");
    originalKeyId = key.id;
    nativeCredential = { kind: "api_key", credentialId: key.id, userId: user.id };
  } else {
    const claims = sessionToken ? await verifyStewardTokenCached(c.env, sessionToken) : null;
    if (!claims) deny("NATIVE_CREDENTIAL", "Native session has expired");
    nativeCredential = {
      kind: "steward_session",
      userId: user.id,
      stewardUserId: claims.userId,
      issuedAt: claims.issuedAt,
    };
  }
  async function readDeveloper() {
    const [app] = await dbWrite
      .select({
        keyId: apps.api_key_id,
        organizationId: apps.organization_id,
        active: apps.is_active,
        approved: apps.is_approved,
      })
      .from(apps)
      .where(eq(apps.id, selection.appId));
    if (
      !app ||
      !app.active ||
      !app.approved ||
      app.organizationId !== selection.developerOrganizationId ||
      !app.keyId
    )
      deny("PROJECTION_UNAVAILABLE", "Application infrastructure credential is not available");
    const key = await apiKeysRepository.findByIdConsistent(app.keyId);
    if (
      !activeKey(key) ||
      key.organization_id !== selection.developerOrganizationId ||
      key.source_app_id !== null
    )
      deny("DEVELOPER_SCOPE", "Application infrastructure credential is no longer active");
    return key;
  }
  const developerKey = await readDeveloper();
  if (
    !developerKey.key_ciphertext ||
    !developerKey.key_nonce ||
    !developerKey.key_auth_tag ||
    !developerKey.key_kms_key_id ||
    developerKey.key_kms_key_version === null
  )
    deny(
      "PROJECTION_UNAVAILABLE",
      "Application infrastructure credential must be provisioned by its developer",
    );
  const plaintext = await decryptApiKey(developerKey.id, {
    ciphertext: developerKey.key_ciphertext,
    nonce: developerKey.key_nonce,
    auth_tag: developerKey.key_auth_tag,
    kms_key_id: developerKey.key_kms_key_id,
    kms_key_version: developerKey.key_kms_key_version,
  });
  if (hash(plaintext) !== developerKey.key_hash)
    deny("PROJECTION_UNAVAILABLE", "Application infrastructure credential binding is unavailable");
  async function revalidate() {
    if (rawKey) {
      const key = await apiKeysRepository.findByHashConsistent(hash(rawKey));
      if (
        !activeKey(key) ||
        key.id !== originalKeyId ||
        key.user_id !== user.id ||
        key.organization_id !== organizationId
      )
        deny("NATIVE_CREDENTIAL", "Native credential was revoked before dispatch");
    } else {
      const claims = sessionToken ? await verifyStewardTokenCached(c.env, sessionToken) : null;
      if (
        !claims ||
        nativeCredential.kind !== "steward_session" ||
        claims.userId !== nativeCredential.stewardUserId ||
        claims.issuedAt !== nativeCredential.issuedAt
      )
        deny("NATIVE_CREDENTIAL", "Native session changed before dispatch");
    }
    await assertInferenceCredentialActive(organizationId, nativeCredential);
    const current = await resolveAppBillingApplicationSlot(selectionInput);
    if (
      current.slotId !== selection.slotId ||
      current.scopeId !== selection.scopeId ||
      current.billingAccountId !== selection.billingAccountId ||
      current.developerOrganizationId !== selection.developerOrganizationId
    )
      deny("NATIVE_CREDENTIAL", "Application product authority changed before dispatch");
    const key = await readDeveloper();
    if (key.id !== developerKey.id || key.key_hash !== developerKey.key_hash)
      deny("DEVELOPER_SCOPE", "Application infrastructure credential changed before dispatch");
  }
  await revalidate();
  const headers = new Headers(request.headers);
  for (const name of [
    "X-Eliza-Application-Slot",
    "X-API-Key",
    "Cookie",
    "X-App-Id",
    "X-Affiliate-Code",
    "X-App-Delegation",
    "X-Eliza-Developer-Authorization",
  ])
    headers.delete(name);
  headers.set("Authorization", `Bearer ${plaintext}`);
  return {
    request: new Request(request, { headers }),
    actor: {
      appId: selection.appId,
      billingAccountId: selection.billingAccountId,
      productFamilyKey: selection.productFamilyKey,
      environment,
      actorUserId: user.id,
      revalidate,
    },
  };
}

/** Keeps missing authority distinguishable from a healthy empty allowance without leaking internal credentials. */
export function nativeApplicationInferenceErrorResponse(error: unknown): Response | null {
  if (error instanceof ElizaError && error.code.startsWith("APP_BILLING_"))
    return Response.json(
      {
        error: {
          code: "APP_INFERENCE_PRODUCT_UNAVAILABLE",
          message: "The selected application product is unavailable for this account",
        },
      },
      { status: 403 },
    );
  return appInferenceErrorResponse(error);
}
