import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import {
  requireApiKeyCredential,
  requireRecentSessionUserWithOrg,
} from "@elizaos/cloud-shared/auth";
import type { DbTransaction } from "@elizaos/cloud-shared/db/client";
import { writeTransaction } from "@elizaos/cloud-shared/db/helpers";
import {
  assertPasswordBackupStorageReady,
  changePasswordBackup,
  MAX_PASSWORD_BACKUP_BYTES,
  type PasswordBackupScope,
  readPasswordBackup,
  readPasswordBackupState,
} from "@elizaos/cloud-shared/db/repositories/password-backup";
import {
  lockBackupDevice,
  readPrivateOwnerAccountAuthority,
} from "@elizaos/cloud-shared/db/repositories/private-owner-credential";
import {
  ApiError,
  AuthenticationError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { isMobileApiKeySecret } from "@elizaos/cloud-shared/lib/auth/mobile-api-key";
import { requireBackupDevice } from "@elizaos/cloud-shared/lib/auth/private-owner-credential";
import {
  putSingleUseRecord,
  takeSingleUseRecord,
} from "@elizaos/cloud-shared/lib/auth/single-use-records";
import { CacheKeys } from "@elizaos/cloud-shared/lib/cache/keys";
import {
  deriveMobileAppAuthS256Challenge,
  isValidMobileAppAuthCodeVerifier,
  MobileAppAuthProtocolError,
  type MobileAppAuthRegistration,
  sha256Hex,
  validateMobileAppAuthClientBinding,
  validateMobileAppAuthPkceBinding,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { resolveStewardBaseUrl } from "../../../../src/steward/base-url";
import { signedStewardPost } from "../../../../src/steward/signed-post";
import {
  MOBILE_APP_AUTH_TOKEN_RATE_LIMIT,
  mobileAppAuthRateLimitMiddleware,
  runMobileAppAuthGrantAdmission,
} from "../_rate-limit";
import { requireRegisteredMobileApp } from "../_registration";
import { mobileAppAuthErrorResponse } from "../_response";
import {
  mobileAppAuthClientBindingSchema,
  mobileAppAuthPkceBindingSchema,
} from "../_schemas";

const purposes = z.enum(["read", "save", "delete", "verify"]);
type Purpose = z.infer<typeof purposes>;
const approvalInput = mobileAppAuthPkceBindingSchema.extend({
  purpose: purposes,
});
const expirySeconds = 300;
const prefixedSecret = /^pbackup_([a-zA-Z0-9_-]{43})$/;
const revisionTag = /^"([1-9][0-9]{0,9})"$/;

type Approval = PasswordBackupScope &
  Pick<
    MobileAppAuthRegistration,
    "clientId" | "environment" | "redirectUri"
  > & {
    expiresAt: number;
    device?: Device & { proofBinding: string };
  };

type Device = {
  apiKeyId: string;
  apiKeyHash: string;
  stewardOwnerId: string;
  packageName: string;
  service: string;
};

const googleChallenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const challengeInput = z
  .object({ approval: approvalInput, googleChallenge })
  .strict();
const nativeInput = z
  .object({
    approval: approvalInput,
    challengeId: z.string().uuid(),
    googleVerifier: z.string().refine(isValidMobileAppAuthCodeVerifier),
    consent: z.literal(true),
    idToken: z.string().min(1).max(8192),
  })
  .strict();
const serverClientId = z
  .string()
  .regex(/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/);
const providerRegistration = z.object({ serverClientId }).strict();
const proofBinding = z.string().regex(/^[a-f0-9]{64}$/);
const providerOwner = providerRegistration.extend({
  ownerBinding: proofBinding,
});
const providerVerified = providerRegistration
  .extend({ verified: z.literal(true), proofBinding })
  .strict();
const providerCurrent = providerRegistration
  .extend({ verified: z.literal(true) })
  .strict();

function verificationService(c: AppContext) {
  const tenant = c.env.STEWARD_TENANT_ID?.trim();
  const base = resolveStewardBaseUrl(c.env);
  const url = base ? new URL(base) : null;
  const tenantKey = c.env.STEWARD_TENANT_API_KEY;
  if (
    !tenant ||
    !url ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
    !c.env.STEWARD_REQUEST_SIGNING_SECRET ||
    !tenantKey
  )
    throw new ApiError(
      503,
      "service_unavailable",
      "Native verification is unavailable",
    );
  return { identity: sha256Hex(JSON.stringify([base, tenant])), tenantKey };
}

async function providerCall<T>(
  c: AppContext,
  operation: "registration" | "verify" | "current",
  payload: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T> {
  const service = verificationService(c);
  const result = await signedStewardPost(
    c,
    `/auth/oauth/google/native/backup/${operation}`,
    payload,
    { "X-Steward-Key": service.tenantKey },
  );
  if (
    !result ||
    result.status >= 500 ||
    (result.status >= 300 && result.status < 400)
  )
    throw new ApiError(
      503,
      "service_unavailable",
      "Native verification is unavailable",
    );
  if (!result.ok) throw AuthenticationError("Native verification was refused");
  return schema.parse(await result.json());
}

function challengeKey(
  id: string,
  approval: Approval,
  device: Device,
  input: z.infer<typeof approvalInput>,
  googlePkce: string,
) {
  return CacheKeys.app.passwordBackupApproval(
    sha256Hex(
      JSON.stringify([
        "native",
        id,
        device.apiKeyId,
        device.apiKeyHash,
        device.service,
        device.stewardOwnerId,
        device.packageName,
        approval.userId,
        approval.organizationId,
        approval.appId,
        input.clientId,
        input.environment,
        input.redirectUri,
        input.purpose,
        input.codeChallenge,
        input.state,
        googlePkce,
      ]),
    ),
  );
}

type StoredChallenge = z.infer<typeof providerOwner> & {
  nonce: string;
  expiresAt: number;
};

function cacheKey(
  code: string,
  challenge: string,
  state: string,
  purpose: Purpose,
) {
  return CacheKeys.app.passwordBackupApproval(
    sha256Hex(JSON.stringify([code, challenge, state, purpose])),
  );
}

function errorResponse(c: AppContext, error: unknown) {
  // error-policy:J1 A database write error can include bound ciphertext. Only serialize typed auth errors.
  if (error instanceof ApiError) return failureResponse(c, error);
  if (error instanceof MobileAppAuthProtocolError)
    return mobileAppAuthErrorResponse(c, error, "password backup");
  return c.json({ error: "password_backup_unavailable" }, 503);
}

function presentedProof(c: AppContext) {
  const code = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  const verifier = c.req.header("X-Backup-Verifier");
  const state = c.req.header("X-Backup-State");
  if (
    !code ||
    !prefixedSecret.test(code) ||
    !verifier ||
    !state ||
    !isValidMobileAppAuthCodeVerifier(verifier) ||
    !isValidMobileAppAuthCodeVerifier(state)
  ) {
    return null;
  }
  return { code, verifier, state };
}

async function redeem(
  c: AppContext,
  purpose: Purpose,
  transfer: (approval: Approval, tx?: DbTransaction) => Promise<Response>,
  proof = presentedProof(c),
) {
  const denied = () => c.json({ error: "backup_approval_required" }, 401);
  if (!proof) return denied();
  const { code, verifier, state } = proof;
  const approval = await takeSingleUseRecord<Approval>(
    cacheKey(code, deriveMobileAppAuthS256Challenge(verifier), state, purpose),
  );
  if (!approval || approval.expiresAt <= Date.now()) return denied();
  const { registration } = await requireRegisteredMobileApp(
    c,
    approval.clientId,
  );
  if (
    registration.appId !== approval.appId ||
    registration.environment !== approval.environment ||
    registration.redirectUri !== approval.redirectUri
  )
    return denied();
  const device = approval.device;
  if (!device) {
    if (
      !(await readPrivateOwnerAccountAuthority(approval)) ||
      approval.expiresAt <= Date.now()
    )
      return denied();
    return await transfer(approval);
  }
  if (verificationService(c).identity !== device.service) return denied();
  await providerCall(
    c,
    "current",
    {
      packageName: device.packageName,
      environment: approval.environment,
      redirectUri: approval.redirectUri,
      ownerId: device.stewardOwnerId,
      proofBinding: device.proofBinding,
    },
    providerCurrent,
  );
  return await writeTransaction(async (tx) => {
    if (!(await lockBackupDevice(tx, device.apiKeyId))) return denied();
    const active = await requireBackupDevice(
      { ...approval, ...device, env: c.env, authMethod: "api_key" },
      approval,
      tx,
    );
    if (
      active.packageName !== device.packageName ||
      active.stewardOwnerId !== device.stewardOwnerId ||
      approval.expiresAt <= Date.now()
    )
      return denied();
    return await transfer(approval, tx);
  });
}

function expectedRevision(c: AppContext): number | null | undefined {
  const match = c.req.header("If-Match");
  const absent = c.req.header("If-None-Match");
  if (match === undefined) return absent === "*" ? null : undefined;
  if (absent !== undefined) return undefined;
  const revision = Number(revisionTag.exec(match)?.[1]);
  return Number.isInteger(revision) && revision <= 2147483647
    ? revision
    : undefined;
}

async function readSnapshot(request: Request): Promise<Buffer | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) return bytes > 0 ? Buffer.concat(chunks, bytes) : null;
      bytes += read.value.byteLength;
      if (bytes > MAX_PASSWORD_BACKUP_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
}

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.use(
  "*",
  mobileAppAuthRateLimitMiddleware(MOBILE_APP_AUTH_TOKEN_RATE_LIMIT),
);

app.post("/", bodyLimit({ maxSize: 8192 }), async (c) => {
  try {
    const bearer = c.req.header("authorization");
    if (
      !bearer?.startsWith("Bearer ") ||
      c.req.header("origin") ||
      c.req.header("cookie")
    ) {
      return c.json({ error: "native_session_required" }, 401);
    }
    const user = await requireRecentSessionUserWithOrg(c);
    if (user.is_anonymous)
      return c.json({ error: "native_session_required" }, 401);
    const decoded = await decodeRequestJson(c.req);
    const parsed = decoded.ok ? approvalInput.safeParse(decoded.value) : null;
    if (!parsed?.success) return c.json({ error: "invalid_approval" }, 400);
    const input = parsed.data;
    const { registration } = await requireRegisteredMobileApp(
      c,
      input.clientId,
    );
    validateMobileAppAuthPkceBinding(registration, input);
    return await runMobileAppAuthGrantAdmission(c, user.id, async () => {
      const code = `pbackup_${randomBytes(32).toString("base64url")}`;
      const approval: Approval = {
        appId: registration.appId,
        organizationId: user.organization_id,
        userId: user.id,
        clientId: registration.clientId,
        environment: registration.environment,
        redirectUri: registration.redirectUri,
        expiresAt: Date.now() + expirySeconds * 1000,
      };
      if (
        !(await putSingleUseRecord(
          cacheKey(code, input.codeChallenge, input.state, input.purpose),
          approval,
          expirySeconds,
        ))
      ) {
        return c.json({ error: "password_backup_unavailable" }, 503);
      }
      return await approvalResponse(c, approval, input.purpose, code);
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

async function approvalResponse(
  c: AppContext,
  approval: Approval,
  purpose: Purpose,
  code: string | null,
) {
  const observed =
    purpose === "verify" ? null : await readPasswordBackupState(approval);
  return c.json({
    code,
    ownerId: approval.userId,
    organizationId: approval.organizationId,
    revision: observed ? `"${observed.revision}"` : null,
    present: observed?.present ?? false,
    scope: sha256Hex(
      JSON.stringify([
        approval.environment,
        approval.appId,
        approval.organizationId,
        approval.userId,
      ]),
    ),
  });
}

async function nativeApproval(
  c: AppContext,
  input: z.infer<typeof approvalInput>,
) {
  if (c.req.raw.headers.has("origin") || c.req.raw.headers.has("cookie"))
    throw AuthenticationError("An acknowledged device is required");
  const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!token || !isMobileApiKeySecret(token))
    throw AuthenticationError("An acknowledged device is required");
  const key = await requireApiKeyCredential(c);
  if (!key.user_id || !key.organization_id)
    throw AuthenticationError("An acknowledged device is required");
  const { registration } = await requireRegisteredMobileApp(c, input.clientId);
  validateMobileAppAuthPkceBinding(registration, input);
  const approval: Approval = {
    userId: key.user_id,
    organizationId: key.organization_id,
    appId: registration.appId,
    environment: registration.environment,
    redirectUri: registration.redirectUri,
    clientId: registration.clientId,
    expiresAt: Date.now() + expirySeconds * 1000,
  };
  const apiKey = { apiKeyId: key.id, apiKeyHash: sha256Hex(token) };
  const active = await requireBackupDevice(
    { ...approval, ...apiKey, env: c.env, authMethod: "api_key" },
    registration,
  );
  const device = {
    ...apiKey,
    ...active,
    service: verificationService(c).identity,
  };
  return {
    approval,
    device,
    provider: {
      packageName: device.packageName,
      environment: approval.environment,
      redirectUri: approval.redirectUri,
    },
  };
}

app.post("/native/challenge", bodyLimit({ maxSize: 8192 }), async (c) => {
  try {
    const body = await decodeRequestJson(c.req);
    const parsed = body.ok ? challengeInput.safeParse(body.value) : null;
    if (!parsed?.success) return c.json({ error: "invalid_approval" }, 400);
    const input = parsed.data;
    const { approval, device, provider } = await nativeApproval(
      c,
      input.approval,
    );
    return await runMobileAppAuthGrantAdmission(
      c,
      approval.userId,
      async () => {
        const { serverClientId, ownerBinding } = await providerCall(
          c,
          "registration",
          { ...provider, ownerId: device.stewardOwnerId },
          providerOwner,
        );
        const challengeId = randomUUID();
        const challenge = {
          nonce: randomBytes(32).toString("base64url"),
          expiresAt: approval.expiresAt,
          serverClientId,
        };
        if (
          !(await putSingleUseRecord(
            challengeKey(
              challengeId,
              approval,
              device,
              input.approval,
              input.googleChallenge,
            ),
            { ...challenge, ownerBinding },
            expirySeconds,
          ))
        )
          return c.json({ error: "password_backup_unavailable" }, 503);
        return c.json({ challengeId, ...challenge });
      },
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/native/approve", bodyLimit({ maxSize: 12288 }), async (c) => {
  try {
    const body = await decodeRequestJson(c.req);
    const parsed = body.ok ? nativeInput.safeParse(body.value) : null;
    if (!parsed?.success) return c.json({ error: "invalid_approval" }, 400);
    const input = parsed.data;
    const { approval, device, provider } = await nativeApproval(
      c,
      input.approval,
    );
    return await runMobileAppAuthGrantAdmission(
      c,
      approval.userId,
      async () => {
        const challenge = await takeSingleUseRecord<StoredChallenge>(
          challengeKey(
            input.challengeId,
            approval,
            device,
            input.approval,
            deriveMobileAppAuthS256Challenge(input.googleVerifier),
          ),
        );
        if (!challenge || challenge.expiresAt <= Date.now())
          return c.json({ error: "backup_approval_required" }, 401);
        const verified = await providerCall(
          c,
          "verify",
          {
            ...provider,
            ownerId: device.stewardOwnerId,
            nonce: challenge.nonce,
            idToken: input.idToken,
            ownerBinding: challenge.ownerBinding,
          },
          providerVerified,
        );
        if (verified.serverClientId !== challenge.serverClientId)
          return c.json({ error: "backup_approval_required" }, 401);
        const active = await requireBackupDevice(
          { ...approval, ...device, env: c.env, authMethod: "api_key" },
          approval,
        );
        if (
          active.stewardOwnerId !== device.stewardOwnerId ||
          active.packageName !== device.packageName ||
          challenge.expiresAt <= Date.now()
        )
          return c.json({ error: "backup_approval_required" }, 401);
        const { purpose, state, codeChallenge } = input.approval;
        const code =
          purpose === "verify"
            ? null
            : `pbackup_${randomBytes(32).toString("base64url")}`;
        if (
          code &&
          !(await putSingleUseRecord(
            cacheKey(code, codeChallenge, state, purpose),
            {
              ...approval,
              device: { ...device, proofBinding: verified.proofBinding },
            },
            expirySeconds,
          ))
        )
          return c.json({ error: "password_backup_unavailable" }, 503);
        return await approvalResponse(c, approval, purpose, code);
      },
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/readiness", async (c) => {
  try {
    const clientId = c.req.query("clientId");
    if (!clientId || clientId.length > 200) return c.body(null, 404);
    const { client, registration } = await requireRegisteredMobileApp(
      c,
      clientId,
    );
    const mode = c.req.query("approval");
    if (mode !== undefined) {
      const input = mobileAppAuthClientBindingSchema.safeParse({
        clientId,
        environment: c.req.query("environment"),
        redirectUri: c.req.query("redirectUri"),
      });
      if (
        mode !== "native-google" ||
        !input.success ||
        !client.android_package_name
      )
        return c.body(null, 404);
      validateMobileAppAuthClientBinding(registration, input.data);
      await providerCall(
        c,
        "registration",
        {
          packageName: client.android_package_name,
          environment: registration.environment,
          redirectUri: registration.redirectUri,
        },
        providerRegistration,
      );
      await assertPasswordBackupStorageReady();
      return c.body(null, 204, { "X-Password-Backup-Version": "3" });
    }
    await assertPasswordBackupStorageReady();
    return c.body(null, 204, { "X-Password-Backup-Version": "2" });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    return await redeem(c, "read", async (scope, tx) => {
      const backup = await readPasswordBackup(scope, tx);
      if (backup) c.header("ETag", `"${backup.revision}"`);
      if (!backup?.snapshot) return c.body(null, 404);
      return c.body(new Uint8Array(backup.snapshot), 200, {
        "Content-Type": "application/octet-stream",
      });
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.put("/", async (c) => {
  try {
    const proof = presentedProof(c);
    if (!proof) return c.json({ error: "backup_approval_required" }, 401);
    const revision = expectedRevision(c);
    if (revision === undefined)
      return c.json({ error: "backup_revision_required" }, 428);
    if (c.req.header("Content-Type") !== "application/octet-stream")
      return c.json({ error: "invalid_content_type" }, 415);
    const snapshot = await readSnapshot(c.req.raw);
    if (!snapshot) return c.json({ error: "invalid_snapshot_size" }, 413);
    return await redeem(
      c,
      "save",
      async (scope, tx) => {
        const change = await changePasswordBackup(
          scope,
          {
            kind: "save",
            expectedRevision: revision,
            snapshot,
          },
          tx,
        );
        if (change.kind === "invalid_size")
          return c.json({ error: "invalid_snapshot_size" }, 413);
        if (change.kind === "conflict")
          return c.json({ error: "backup_revision_conflict" }, 412);
        return c.body(null, 204, { ETag: `"${change.revision}"` });
      },
      proof,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    return await redeem(c, "delete", async (scope, tx) => {
      const revision = expectedRevision(c);
      if (revision == null)
        return c.json({ error: "backup_revision_required" }, 428);
      const change = await changePasswordBackup(
        scope,
        {
          kind: "delete",
          expectedRevision: revision,
        },
        tx,
      );
      if (change.kind !== "changed")
        return c.json({ error: "backup_revision_conflict" }, 412);
      return c.body(null, 204, { ETag: `"${change.revision}"` });
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default app;
