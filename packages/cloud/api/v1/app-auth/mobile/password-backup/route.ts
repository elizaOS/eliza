import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { requireRecentSessionUserWithOrg } from "@elizaos/cloud-shared/auth";
import {
  assertPasswordBackupStorageReady,
  changePasswordBackup,
  MAX_PASSWORD_BACKUP_BYTES,
  type PasswordBackupScope,
  readPasswordBackup,
  readPasswordBackupState,
} from "@elizaos/cloud-shared/db/repositories/password-backup";
import { readPrivateOwnerAccountAuthority } from "@elizaos/cloud-shared/db/repositories/private-owner-credential";
import {
  ApiError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  putSingleUseRecord,
  takeSingleUseRecord,
} from "@elizaos/cloud-shared/lib/auth/single-use-records";
import { CacheKeys } from "@elizaos/cloud-shared/lib/cache/keys";
import {
  deriveMobileAppAuthS256Challenge,
  isValidMobileAppAuthCodeVerifier,
  MobileAppAuthProtocolError,
  sha256Hex,
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
import {
  MOBILE_APP_AUTH_TOKEN_RATE_LIMIT,
  mobileAppAuthRateLimitMiddleware,
  runMobileAppAuthGrantAdmission,
} from "../_rate-limit";
import { requireRegisteredMobileApp } from "../_registration";
import { mobileAppAuthErrorResponse } from "../_response";
import { mobileAppAuthPkceBindingSchema } from "../_schemas";

const purposes = z.enum(["read", "save", "delete", "verify"]);
type Purpose = z.infer<typeof purposes>;
const approvalInput = mobileAppAuthPkceBindingSchema.extend({
  purpose: purposes,
});
const expirySeconds = 300;
const prefixedSecret = /^pbackup_([a-zA-Z0-9_-]{43})$/;
const revisionTag = /^"([1-9][0-9]{0,9})"$/;

type Approval = PasswordBackupScope & {
  clientId: string;
  environment: string;
  redirectUri: string;
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
  proof = presentedProof(c),
): Promise<Approval | null> {
  if (!proof) return null;
  const { code, verifier, state } = proof;
  const approval = await takeSingleUseRecord<Approval>(
    cacheKey(code, deriveMobileAppAuthS256Challenge(verifier), state, purpose),
  );
  return approval && (await approvalIsCurrent(c, approval)) ? approval : null;
}

async function approvalIsCurrent(
  c: AppContext,
  approval: Approval,
): Promise<boolean> {
  if (approval.expiresAt <= Date.now()) return false;
  const { registration } = await requireRegisteredMobileApp(
    c,
    approval.clientId,
  );
  return (
    registration.appId === approval.appId &&
    registration.environment === approval.environment &&
    registration.redirectUri === approval.redirectUri &&
    Boolean(await readPrivateOwnerAccountAuthority(approval)) &&
    approval.expiresAt > Date.now()
  );
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
      const observed =
        input.purpose === "verify"
          ? null
          : await readPasswordBackupState(approval);
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
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/readiness", async (c) => {
  try {
    const clientId = c.req.query("clientId");
    if (!clientId || clientId.length > 200) return c.body(null, 404);
    await requireRegisteredMobileApp(c, clientId);
    await assertPasswordBackupStorageReady();
    return c.body(null, 204, { "X-Password-Backup-Version": "2" });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const scope = await redeem(c, "read");
    if (!scope) return c.json({ error: "backup_approval_required" }, 401);
    const backup = await readPasswordBackup(scope);
    if (backup) c.header("ETag", `"${backup.revision}"`);
    if (!backup?.snapshot) return c.body(null, 404);
    return c.body(new Uint8Array(backup.snapshot), 200, {
      "Content-Type": "application/octet-stream",
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
    const scope = await redeem(c, "save", proof);
    if (!scope) return c.json({ error: "backup_approval_required" }, 401);
    const change = await changePasswordBackup(scope, {
      kind: "save",
      expectedRevision: revision,
      snapshot,
    });
    if (change.kind === "invalid_size")
      return c.json({ error: "invalid_snapshot_size" }, 413);
    if (change.kind === "conflict")
      return c.json({ error: "backup_revision_conflict" }, 412);
    return c.body(null, 204, { ETag: `"${change.revision}"` });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const scope = await redeem(c, "delete");
    if (!scope) return c.json({ error: "backup_approval_required" }, 401);
    const revision = expectedRevision(c);
    if (revision == null)
      return c.json({ error: "backup_revision_required" }, 428);
    const change = await changePasswordBackup(scope, {
      kind: "delete",
      expectedRevision: revision,
    });
    if (change.kind !== "changed")
      return c.json({ error: "backup_revision_conflict" }, 412);
    return c.body(null, 204, { ETag: `"${change.revision}"` });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default app;
