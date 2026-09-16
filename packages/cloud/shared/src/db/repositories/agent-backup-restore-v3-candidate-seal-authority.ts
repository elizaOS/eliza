/** Durable one-shot authority and byte-exact seal/replay for restore-v3 candidates. */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type AgentBackupRestoreV3CandidateReceipt,
  type AgentBackupRestoreV3CandidateSealAuthority,
  type AgentBackupRestoreV3CandidateSealAuthorization,
  type AgentBackupRestoreV3CandidateSealAuthorizationRequest,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3StagingSession,
  canonicalizeAgentBackupRestoreV3CandidateReceipt,
  canonicalizeAgentBackupRestoreV3CandidateSealAuthorizationRequest,
  parseAgentBackupRestoreV3CandidateReceipt,
  parseAgentBackupRestoreV3CandidateSealAuthorization,
  parseAgentBackupRestoreV3CandidateSealAuthorizationRequest,
  parseAgentBackupRestoreV3StagingSession,
} from "@elizaos/shared";
import { and, eq, sql } from "drizzle-orm";
import { isValidUUID } from "../../lib/utils/validation";
import { dbWrite } from "../helpers";
import {
  type AgentBackupRestoreV3Candidate,
  type AgentBackupRestoreV3CandidateSealAuthorizationRow,
  type AgentBackupRestoreV3CandidateTerminalCommand,
  agentBackupRestoreV3CandidateSealAuthorizations,
  agentBackupRestoreV3Candidates,
  agentBackupRestoreV3CandidateTerminalCommands,
} from "../schemas/agent-backup-restore-v3-candidates";
import { exactDigestMatches, sha256Utf8 } from "./agent-backup-restore-v3-candidate-codec";
import {
  agentBackupRestoreV3DatabaseSqlState,
  applyAgentBackupRestoreV3TransactionDeadline,
  assertAgentBackupRestoreV3OperationControl,
  isAgentBackupRestoreV3AmbiguousCommitResponse,
  snapshotAgentBackupRestoreV3OperationControl,
  throwIfAgentBackupRestoreV3DatabaseDeadline,
} from "./agent-backup-restore-v3-candidate-database-control";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const AUTHORIZATION_TTL_MS = 60_000;
// Leave headroom inside the caller's 5s cleanup fence so the repository can
// settle and return before the outer timer detaches this read-only recovery.
const AMBIGUOUS_COMMIT_RECOVERY_MS = 4_000;
const AMBIGUOUS_COMMIT_RECOVERY_POLL_MS = 25;
const ADDITIONAL_AMBIGUOUS_COMMIT_SQL_STATES = new Set(["40003", "57P02"]);
const SEAL_COMMAND_CONTEXT = "elizaos.agent-backup.restore-v3-candidate-seal-command.v1";

export class AgentBackupRestoreV3CandidateSealConflictError extends Error {
  readonly code = "AGENT_BACKUP_RESTORE_V3_CANDIDATE_SEAL_CONFLICT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentBackupRestoreV3CandidateSealConflictError";
  }
}

interface BoundSealAuthorization {
  readonly authorizationId: string;
  readonly proofBytes: Buffer;
  readonly proofTokenSha256: string;
  readonly requestSha256: string;
  readonly executionTokenSha256: string;
  proofDestroyAtEpochMs: number;
  proofDestroyTimer?: ReturnType<typeof setTimeout>;
  proofZeroized: boolean;
  expiresAtEpochMs?: number;
}

type CandidateAuthorityBinding = Readonly<
  Pick<AgentBackupRestoreV3CandidateSealAuthorizationRequest, "authority" | "candidate">
>;

type PreparedStagingSession = Readonly<Omit<AgentBackupRestoreV3StagingSession, "executionToken">>;

type PreparedAuthorization = Readonly<
  Omit<AgentBackupRestoreV3CandidateSealAuthorization, "proofToken" | "sessionExecutionToken">
>;

interface PreparedSeal {
  readonly session: PreparedStagingSession;
  readonly receipt: AgentBackupRestoreV3CandidateReceipt;
  readonly receiptCanonical: string;
  readonly receiptSha256: string;
  readonly authorization: PreparedAuthorization;
  readonly authorizationRequestSha256: string;
  readonly executionTokenSha256: string;
  readonly proofTokenSha256: string;
  readonly terminalCommandId: string;
  readonly terminalCommandSha256: string;
}

function sha256BearerUtf8(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  try {
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

function zeroizeBoundProof(bound: BoundSealAuthorization): void {
  if (bound.proofZeroized) return;
  bound.proofBytes.fill(0);
  bound.proofZeroized = true;
  if (bound.proofDestroyTimer) clearTimeout(bound.proofDestroyTimer);
  bound.proofDestroyTimer = undefined;
}

function scheduleBoundProofZeroization(
  bound: BoundSealAuthorization,
  expiresAtEpochMs: number,
): void {
  bound.proofDestroyAtEpochMs = Math.min(bound.proofDestroyAtEpochMs, expiresAtEpochMs);
  if (bound.proofDestroyTimer) clearTimeout(bound.proofDestroyTimer);
  const delayMs = Math.max(0, bound.proofDestroyAtEpochMs - Date.now());
  bound.proofDestroyTimer = setTimeout(() => zeroizeBoundProof(bound), delayMs);
  bound.proofDestroyTimer.unref?.();
}

function conflict(
  message: string,
  cause?: unknown,
): AgentBackupRestoreV3CandidateSealConflictError {
  return new AgentBackupRestoreV3CandidateSealConflictError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function asDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw conflict(`Database returned an invalid ${field}`);
  }
  return date;
}

function recoveryControl(
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  cause: unknown,
  forceFresh = false,
): Readonly<AgentBackupRestoreV3OperationControl> {
  if (!forceFresh && !isCandidateSealCommitAmbiguous(cause)) {
    return snapshotAgentBackupRestoreV3OperationControl(control);
  }
  // A lost COMMIT acknowledgement must get one bounded, read-only PRIMARY
  // lookup even if the caller's signal was tripped while the driver failed.
  return Object.freeze({
    signal: new AbortController().signal,
    deadlineEpochMs: Date.now() + AMBIGUOUS_COMMIT_RECOVERY_MS,
  });
}

function isCandidateSealCommitAmbiguous(cause: unknown): boolean {
  const sqlState = agentBackupRestoreV3DatabaseSqlState(cause);
  return (
    (sqlState !== undefined && ADDITIONAL_AMBIGUOUS_COMMIT_SQL_STATES.has(sqlState)) ||
    isAgentBackupRestoreV3AmbiguousCommitResponse(cause)
  );
}

function isValidInactiveControl(control: Readonly<AgentBackupRestoreV3OperationControl>): boolean {
  return (
    Number.isSafeInteger(control.deadlineEpochMs) &&
    control.deadlineEpochMs > 0 &&
    (control.signal.aborted || Date.now() >= control.deadlineEpochMs)
  );
}

function exactCandidateAuthorityMatches(
  row: AgentBackupRestoreV3Candidate,
  request: CandidateAuthorityBinding,
  executionTokenSha256: string,
): boolean {
  const authority = request.authority;
  const candidate = request.candidate;
  return (
    row.organization_id === authority.organizationId &&
    row.agent_id === authority.agentId &&
    row.backup_id === authority.backupId &&
    row.restore_attempt_id === authority.restoreAttemptId &&
    row.operation_id === authority.operationId &&
    row.lease_id === authority.leaseId &&
    row.lease_owner_id === authority.ownerId &&
    row.lease_generation === authority.fencingToken &&
    asDate(row.lease_expires_at, "candidate lease expiry").getTime() ===
      authority.leaseExpiresAtEpochMs &&
    BigInt(row.catalog_epoch) === BigInt(authority.catalogEpoch) &&
    row.source_copy_role === authority.copyRole &&
    row.source_activation_generation === authority.sourceActivationGeneration &&
    BigInt(row.source_lifecycle_revision) === BigInt(authority.sourceLifecycleRevision) &&
    row.expected_manifest_sha256 === authority.expectedManifestSha256 &&
    row.expected_manifest_sha256 === candidate.expectedManifestSha256 &&
    row.key_bundle_generation_id === candidate.keyBundleGenerationId &&
    row.source_copy_role === candidate.sourceCopyRole &&
    exactDigestMatches(row.source_authority_sha256, candidate.sourceAuthoritySha256) &&
    row.object_count === candidate.objectCount &&
    exactDigestMatches(row.execution_token_sha256, executionTokenSha256)
  );
}

function exactAuthorizationRowMatches(
  row: AgentBackupRestoreV3CandidateSealAuthorizationRow,
  input: {
    readonly candidateId: string;
    readonly request: CandidateAuthorityBinding;
    readonly authorizationId: string;
    readonly authorizationRequestSha256: string;
    readonly executionTokenSha256: string;
    readonly proofTokenSha256: string;
    readonly expiresAtEpochMs: number;
    readonly state: "active" | "consumed";
  },
): boolean {
  const authority = input.request.authority;
  const candidate = input.request.candidate;
  return (
    row.id === input.authorizationId &&
    row.candidate_id === input.candidateId &&
    row.organization_id === authority.organizationId &&
    row.agent_id === authority.agentId &&
    row.backup_id === authority.backupId &&
    row.restore_attempt_id === candidate.restoreAttemptId &&
    row.operation_id === candidate.operationId &&
    exactDigestMatches(row.execution_token_sha256, input.executionTokenSha256) &&
    row.expected_manifest_sha256 === candidate.expectedManifestSha256 &&
    row.key_bundle_generation_id === candidate.keyBundleGenerationId &&
    row.source_copy_role === candidate.sourceCopyRole &&
    exactDigestMatches(row.source_authority_sha256, candidate.sourceAuthoritySha256) &&
    row.object_count === candidate.objectCount &&
    exactDigestMatches(row.candidate_receipt_sha256, candidate.candidateReceiptSha256) &&
    exactDigestMatches(row.authorization_request_sha256, input.authorizationRequestSha256) &&
    exactDigestMatches(row.proof_token_sha256, input.proofTokenSha256) &&
    asDate(row.expires_at, "seal authorization expiry").getTime() === input.expiresAtEpochMs &&
    row.state === input.state &&
    (input.state !== "consumed" || row.consumed_at !== null)
  );
}

function computeSealCommandSha256(input: {
  readonly terminalCommandId: string;
  readonly candidateId: string;
  readonly authorizationId: string;
  readonly authorizationRequestSha256: string;
  readonly executionTokenSha256: string;
  readonly proofTokenSha256: string;
  readonly receiptSha256: string;
}): string {
  // A JSON array has a single unambiguous order and contains only identifiers
  // and digests. Neither bearer token nor receipt plaintext enters this preimage.
  return sha256Utf8(
    JSON.stringify([
      SEAL_COMMAND_CONTEXT,
      "seal",
      input.terminalCommandId,
      input.candidateId,
      input.authorizationId,
      input.authorizationRequestSha256,
      input.executionTokenSha256,
      input.proofTokenSha256,
      input.receiptSha256,
    ]),
  );
}

function authorizationFromBound(
  bound: BoundSealAuthorization,
  request: Readonly<AgentBackupRestoreV3CandidateSealAuthorizationRequest>,
  proofToken: string,
): Readonly<AgentBackupRestoreV3CandidateSealAuthorization> {
  if (bound.expiresAtEpochMs === undefined) {
    throw conflict("Restore-v3 seal authorization expiry was not bound");
  }
  return parseAgentBackupRestoreV3CandidateSealAuthorization({
    current: true,
    authority: request.authority,
    authorizationId: bound.authorizationId,
    sessionExecutionToken: request.sessionExecutionToken,
    candidate: request.candidate,
    expiresAtEpochMs: bound.expiresAtEpochMs,
    proofToken,
  });
}

async function readExactAuthorizationSnapshot(
  bound: BoundSealAuthorization,
  request: Readonly<AgentBackupRestoreV3CandidateSealAuthorizationRequest>,
  proofToken: string,
  boundedControl: Readonly<AgentBackupRestoreV3OperationControl>,
  cause: unknown,
): Promise<Readonly<AgentBackupRestoreV3CandidateSealAuthorization> | null> {
  if (bound.expiresAtEpochMs === undefined) return null;
  if (bound.proofZeroized || Date.now() >= bound.proofDestroyAtEpochMs) {
    zeroizeBoundProof(bound);
    throw conflict("Restore-v3 seal proof material expired before replay", cause);
  }
  const expiresAtEpochMs = bound.expiresAtEpochMs;
  const authorization = await dbWrite.transaction(async (tx) => {
    assertAgentBackupRestoreV3OperationControl(
      boundedControl,
      "Restore-v3 seal authorization recovery",
    );
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await applyAgentBackupRestoreV3TransactionDeadline(
      tx,
      boundedControl,
      "Restore-v3 seal authorization recovery",
    );
    const [row] = await tx
      .select()
      .from(agentBackupRestoreV3CandidateSealAuthorizations)
      .where(eq(agentBackupRestoreV3CandidateSealAuthorizations.id, bound.authorizationId))
      .limit(1);
    await applyAgentBackupRestoreV3TransactionDeadline(
      tx,
      boundedControl,
      "Restore-v3 seal authorization recovery",
    );
    if (!row) return null;
    if (
      !exactAuthorizationRowMatches(row, {
        candidateId: row.candidate_id,
        request,
        authorizationId: bound.authorizationId,
        authorizationRequestSha256: bound.requestSha256,
        executionTokenSha256: bound.executionTokenSha256,
        proofTokenSha256: bound.proofTokenSha256,
        expiresAtEpochMs,
        state: "active",
      })
    ) {
      throw conflict("Restore-v3 seal authorization replay is divergent", cause);
    }
    await applyAgentBackupRestoreV3TransactionDeadline(
      tx,
      boundedControl,
      "Restore-v3 seal authorization recovery",
    );
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (asDate(row.expires_at, "seal authorization expiry").getTime() <= databaseNow.getTime()) {
      throw conflict("Restore-v3 seal authorization replay is expired", cause);
    }
    if (bound.proofZeroized || Date.now() >= bound.proofDestroyAtEpochMs) {
      zeroizeBoundProof(bound);
      throw conflict("Restore-v3 seal proof material expired during replay", cause);
    }
    await applyAgentBackupRestoreV3TransactionDeadline(
      tx,
      boundedControl,
      "Restore-v3 seal authorization recovery",
    );
    return authorizationFromBound(bound, request, proofToken);
  });
  if (
    authorization &&
    (bound.proofZeroized ||
      Date.now() >= expiresAtEpochMs ||
      Date.now() >= bound.proofDestroyAtEpochMs)
  ) {
    zeroizeBoundProof(bound);
    throw conflict("Restore-v3 seal proof material expired before replay response", cause);
  }
  return authorization;
}

async function readExactAuthorization(
  bound: BoundSealAuthorization,
  request: Readonly<AgentBackupRestoreV3CandidateSealAuthorizationRequest>,
  proofToken: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  cause: unknown,
): Promise<Readonly<AgentBackupRestoreV3CandidateSealAuthorization> | null> {
  return readExactAuthorizationSnapshot(
    bound,
    request,
    proofToken,
    recoveryControl(control, cause),
    cause,
  );
}

async function waitForExactAuthorization(
  bound: BoundSealAuthorization,
  request: Readonly<AgentBackupRestoreV3CandidateSealAuthorizationRequest>,
  proofToken: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  cause: unknown,
): Promise<Readonly<AgentBackupRestoreV3CandidateSealAuthorization> | null> {
  if (bound.expiresAtEpochMs === undefined) return null;
  const freshControl = recoveryControl(control, cause, true);
  const boundedControl = Object.freeze({
    signal: freshControl.signal,
    deadlineEpochMs: Math.min(
      freshControl.deadlineEpochMs,
      bound.expiresAtEpochMs,
      bound.proofDestroyAtEpochMs,
    ),
  });
  while (Date.now() < boundedControl.deadlineEpochMs) {
    try {
      const exact = await readExactAuthorizationSnapshot(
        bound,
        request,
        proofToken,
        boundedControl,
        cause,
      );
      if (exact) return exact;
    } catch (replayCause) {
      if (replayCause instanceof AgentBackupRestoreV3CandidateSealConflictError) {
        throw replayCause;
      }
      const sqlState = agentBackupRestoreV3DatabaseSqlState(replayCause);
      if (
        Date.now() >= boundedControl.deadlineEpochMs ||
        (replayCause instanceof DOMException && replayCause.name === "AbortError") ||
        sqlState === "55P03" ||
        sqlState === "57014"
      ) {
        return null;
      }
      if (!isCandidateSealCommitAmbiguous(replayCause)) throw replayCause;
    }
    const remainingMs = boundedControl.deadlineEpochMs - Date.now();
    if (remainingMs <= 0) return null;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(AMBIGUOUS_COMMIT_RECOVERY_POLL_MS, remainingMs));
    });
  }
  return null;
}

class CandidateSealAuthorityRepository implements AgentBackupRestoreV3CandidateSealAuthority {
  #bound: BoundSealAuthorization | undefined;

  authorize(
    requestInput: AgentBackupRestoreV3CandidateSealAuthorizationRequest,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<Readonly<AgentBackupRestoreV3CandidateSealAuthorization>> {
    const operationControl = snapshotAgentBackupRestoreV3OperationControl(control);
    assertAgentBackupRestoreV3OperationControl(operationControl, "Restore-v3 seal authorization");
    const request = parseAgentBackupRestoreV3CandidateSealAuthorizationRequest(requestInput);
    const requestCanonical =
      canonicalizeAgentBackupRestoreV3CandidateSealAuthorizationRequest(request);
    const requestSha256 = sha256Utf8(requestCanonical);
    const executionTokenSha256 = sha256BearerUtf8(request.sessionExecutionToken);
    if (!this.#bound) {
      const proofBytes = randomBytes(32);
      const proofTokenSha256 = sha256BearerUtf8(proofBytes.toString("base64url"));
      this.#bound = {
        authorizationId: randomUUID(),
        proofBytes,
        proofTokenSha256,
        requestSha256,
        executionTokenSha256,
        proofDestroyAtEpochMs: Date.now() + AUTHORIZATION_TTL_MS,
        proofZeroized: false,
      };
      scheduleBoundProofZeroization(this.#bound, this.#bound.proofDestroyAtEpochMs);
    } else if (
      !exactDigestMatches(this.#bound.requestSha256, requestSha256) ||
      !exactDigestMatches(this.#bound.executionTokenSha256, executionTokenSha256)
    ) {
      throw conflict("Restore-v3 seal authority is already bound to another exact request");
    }
    const bound = this.#bound;
    if (
      bound.proofZeroized ||
      (bound.expiresAtEpochMs !== undefined && Date.now() >= bound.expiresAtEpochMs)
    ) {
      zeroizeBoundProof(bound);
      throw conflict("Restore-v3 seal proof material is expired or was disposed");
    }
    // Each caller owns a short-lived copy. The factory retains only wipeable
    // random bytes (never a bearer string) until the bounded expiry.
    const proofBytes = Buffer.from(bound.proofBytes);
    const proofToken = proofBytes.toString("base64url");
    return this.#authorize(bound, request, proofToken, operationControl).finally(() => {
      proofBytes.fill(0);
    });
  }

  async #authorize(
    bound: BoundSealAuthorization,
    request: Readonly<AgentBackupRestoreV3CandidateSealAuthorizationRequest>,
    proofToken: string,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<Readonly<AgentBackupRestoreV3CandidateSealAuthorization>> {
    const authorizationControl = Object.freeze({
      signal: control.signal,
      deadlineEpochMs: Math.min(control.deadlineEpochMs, bound.proofDestroyAtEpochMs),
    });
    try {
      const authorization = await dbWrite.transaction(async (tx) => {
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          authorizationControl,
          "Restore-v3 seal authorization",
        );
        // Non-locking discovery only. The INSERT trigger is the sole owner of
        // backup -> operation -> lease -> catalogue -> object -> candidate order.
        const [candidate] = await tx
          .select()
          .from(agentBackupRestoreV3Candidates)
          .where(
            and(
              eq(agentBackupRestoreV3Candidates.organization_id, request.authority.organizationId),
              eq(
                agentBackupRestoreV3Candidates.restore_attempt_id,
                request.authority.restoreAttemptId,
              ),
            ),
          )
          .limit(1);
        if (
          !candidate ||
          candidate.state !== "active" ||
          !exactCandidateAuthorityMatches(candidate, request, bound.executionTokenSha256)
        ) {
          throw conflict("Restore-v3 seal authorization lacks its exact active candidate");
        }
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          authorizationControl,
          "Restore-v3 seal authorization",
        );
        const databaseNow = await readPostLockDatabaseNow(tx);
        bound.expiresAtEpochMs ??= Math.min(
          request.authority.leaseExpiresAtEpochMs,
          authorizationControl.deadlineEpochMs,
          databaseNow.getTime() + AUTHORIZATION_TTL_MS,
          bound.proofDestroyAtEpochMs,
        );
        scheduleBoundProofZeroization(bound, bound.expiresAtEpochMs);
        if (
          bound.expiresAtEpochMs <= databaseNow.getTime() ||
          bound.expiresAtEpochMs > authorizationControl.deadlineEpochMs
        ) {
          throw conflict("Restore-v3 seal authorization has no live bounded interval");
        }
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          authorizationControl,
          "Restore-v3 seal authorization",
        );
        await tx.insert(agentBackupRestoreV3CandidateSealAuthorizations).values({
          id: bound.authorizationId,
          candidate_id: candidate.id,
          organization_id: request.authority.organizationId,
          agent_id: request.authority.agentId,
          backup_id: request.authority.backupId,
          restore_attempt_id: request.candidate.restoreAttemptId,
          operation_id: request.candidate.operationId,
          execution_token_sha256: bound.executionTokenSha256,
          expected_manifest_sha256: request.candidate.expectedManifestSha256,
          key_bundle_generation_id: request.candidate.keyBundleGenerationId,
          source_copy_role: request.candidate.sourceCopyRole,
          source_authority_sha256: request.candidate.sourceAuthoritySha256,
          object_count: request.candidate.objectCount,
          candidate_receipt_sha256: request.candidate.candidateReceiptSha256,
          authorization_request_sha256: bound.requestSha256,
          proof_token_sha256: bound.proofTokenSha256,
          expires_at: new Date(bound.expiresAtEpochMs),
        });
        await applyAgentBackupRestoreV3TransactionDeadline(
          tx,
          authorizationControl,
          "Restore-v3 seal authorization",
        );
        if (bound.proofZeroized) {
          throw conflict("Restore-v3 seal proof material expired during authorization");
        }
        return authorizationFromBound(bound, request, proofToken);
      });
      if (
        bound.proofZeroized ||
        bound.expiresAtEpochMs === undefined ||
        Date.now() >= bound.expiresAtEpochMs ||
        Date.now() >= bound.proofDestroyAtEpochMs
      ) {
        zeroizeBoundProof(bound);
        throw conflict("Restore-v3 seal proof material expired before authorization response");
      }
      return authorization;
    } catch (cause) {
      throwIfAgentBackupRestoreV3DatabaseDeadline(cause, "Restore-v3 seal authorization");
      const sqlState = agentBackupRestoreV3DatabaseSqlState(cause);
      if (sqlState !== "23505" && !isCandidateSealCommitAmbiguous(cause)) {
        throw cause;
      }
      const exact = isCandidateSealCommitAmbiguous(cause)
        ? await waitForExactAuthorization(bound, request, proofToken, control, cause)
        : await readExactAuthorization(bound, request, proofToken, control, cause);
      if (exact) return exact;
      throw cause;
    }
  }
}

function prepareSeal(
  sessionInput: Readonly<AgentBackupRestoreV3StagingSession>,
  receiptInput: Readonly<AgentBackupRestoreV3CandidateReceipt>,
  authorizationInput: Readonly<AgentBackupRestoreV3CandidateSealAuthorization>,
): PreparedSeal {
  // Parse/canonicalize synchronously before the first yield so caller mutation
  // cannot alter the durable bytes or either bearer digest.
  const session = parseAgentBackupRestoreV3StagingSession(sessionInput);
  const receiptCanonical = canonicalizeAgentBackupRestoreV3CandidateReceipt(receiptInput);
  const receipt = parseAgentBackupRestoreV3CandidateReceipt(JSON.parse(receiptCanonical));
  const authorization = parseAgentBackupRestoreV3CandidateSealAuthorization(authorizationInput);
  if (
    !isValidUUID(session.stagingHandle) ||
    session.stagingHandle !== session.stagingHandle.toLowerCase()
  ) {
    throw conflict("Restore-v3 staging handle must be a canonical lowercase UUID");
  }
  const authorizationRequest = parseAgentBackupRestoreV3CandidateSealAuthorizationRequest({
    authority: authorization.authority,
    sessionExecutionToken: authorization.sessionExecutionToken,
    candidate: authorization.candidate,
  });
  const authorizationRequestSha256 = sha256Utf8(
    canonicalizeAgentBackupRestoreV3CandidateSealAuthorizationRequest(authorizationRequest),
  );
  const executionTokenSha256 = sha256BearerUtf8(session.executionToken);
  const authorizationExecutionTokenSha256 = sha256BearerUtf8(authorization.sessionExecutionToken);
  const receiptSha256 = sha256Utf8(receiptCanonical);
  if (
    session.restoreAttemptId !== authorization.candidate.restoreAttemptId ||
    session.restoreAttemptId !== receipt.restoreAttemptId ||
    session.operationId !== authorization.candidate.operationId ||
    session.operationId !== receipt.operationId ||
    session.expectedManifestSha256 !== authorization.candidate.expectedManifestSha256 ||
    session.expectedManifestSha256 !== receipt.expectedManifestSha256 ||
    !exactDigestMatches(executionTokenSha256, authorizationExecutionTokenSha256) ||
    receipt.keyBundleGenerationId !== authorization.candidate.keyBundleGenerationId ||
    receipt.sourceCopyRole !== authorization.candidate.sourceCopyRole ||
    !exactDigestMatches(
      receipt.sourceAuthoritySha256,
      authorization.candidate.sourceAuthoritySha256,
    ) ||
    receipt.objectCount !== authorization.candidate.objectCount ||
    !exactDigestMatches(receiptSha256, authorization.candidate.candidateReceiptSha256)
  ) {
    throw conflict("Restore-v3 seal inputs differ from their exact authorization");
  }
  const proofTokenSha256 = sha256BearerUtf8(authorization.proofToken);
  const terminalCommandId = authorization.authorizationId;
  return Object.freeze({
    session: Object.freeze({
      restoreAttemptId: session.restoreAttemptId,
      operationId: session.operationId,
      expectedManifestSha256: session.expectedManifestSha256,
      stagingHandle: session.stagingHandle,
      cleanupHandle: session.cleanupHandle,
      cleanupRegistered: session.cleanupRegistered,
      isolatedCandidate: session.isolatedCandidate,
    }),
    receipt,
    receiptCanonical,
    receiptSha256,
    authorization: Object.freeze({
      current: authorization.current,
      authority: authorization.authority,
      authorizationId: authorization.authorizationId,
      candidate: authorization.candidate,
      expiresAtEpochMs: authorization.expiresAtEpochMs,
    }),
    authorizationRequestSha256,
    executionTokenSha256,
    proofTokenSha256,
    terminalCommandId,
    terminalCommandSha256: computeSealCommandSha256({
      terminalCommandId,
      candidateId: session.stagingHandle,
      authorizationId: authorization.authorizationId,
      authorizationRequestSha256,
      executionTokenSha256,
      proofTokenSha256,
      receiptSha256,
    }),
  });
}

function exactTerminalMatches(
  row: AgentBackupRestoreV3CandidateTerminalCommand,
  prepared: PreparedSeal,
): boolean {
  const authority = prepared.authorization.authority;
  return (
    row.id === prepared.terminalCommandId &&
    row.candidate_id === prepared.session.stagingHandle &&
    row.organization_id === authority.organizationId &&
    row.agent_id === authority.agentId &&
    row.backup_id === authority.backupId &&
    row.restore_attempt_id === prepared.session.restoreAttemptId &&
    row.operation_id === prepared.session.operationId &&
    exactDigestMatches(row.execution_token_sha256, prepared.executionTokenSha256) &&
    row.command_kind === "seal" &&
    row.authorization_id === prepared.authorization.authorizationId &&
    exactDigestMatches(row.proof_token_sha256 ?? "", prepared.proofTokenSha256) &&
    row.sealed_receipt_canonical === prepared.receiptCanonical &&
    exactDigestMatches(row.sealed_receipt_sha256 ?? "", prepared.receiptSha256) &&
    row.abort_reason_sha256 === null &&
    exactDigestMatches(row.command_sha256, prepared.terminalCommandSha256)
  );
}

async function readExactSealedReceiptSnapshot(
  prepared: PreparedSeal,
  boundedControl: Readonly<AgentBackupRestoreV3OperationControl>,
  cause: unknown,
): Promise<AgentBackupRestoreV3CandidateReceipt | null> {
  return dbWrite.transaction(async (tx) => {
    // One immutable snapshot prevents a concurrent terminal transition from
    // being observed as a mixture. Every statement below is read-only PRIMARY.
    assertAgentBackupRestoreV3OperationControl(boundedControl, "Restore-v3 candidate seal replay");
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await applyAgentBackupRestoreV3TransactionDeadline(
      tx,
      boundedControl,
      "Restore-v3 candidate seal replay",
    );
    const [candidate] = await tx
      .select()
      .from(agentBackupRestoreV3Candidates)
      .where(eq(agentBackupRestoreV3Candidates.id, prepared.session.stagingHandle))
      .limit(1);
    await applyAgentBackupRestoreV3TransactionDeadline(
      tx,
      boundedControl,
      "Restore-v3 candidate seal replay",
    );
    const [authorization] = await tx
      .select()
      .from(agentBackupRestoreV3CandidateSealAuthorizations)
      .where(
        eq(
          agentBackupRestoreV3CandidateSealAuthorizations.id,
          prepared.authorization.authorizationId,
        ),
      )
      .limit(1);
    await applyAgentBackupRestoreV3TransactionDeadline(
      tx,
      boundedControl,
      "Restore-v3 candidate seal replay",
    );
    const [terminal] = await tx
      .select()
      .from(agentBackupRestoreV3CandidateTerminalCommands)
      .where(
        eq(
          agentBackupRestoreV3CandidateTerminalCommands.candidate_id,
          prepared.session.stagingHandle,
        ),
      )
      .limit(1);
    await applyAgentBackupRestoreV3TransactionDeadline(
      tx,
      boundedControl,
      "Restore-v3 candidate seal replay",
    );
    if (!terminal) return null;
    if (
      !candidate ||
      !authorization ||
      candidate.state !== "sealed" ||
      candidate.cleanup_outbox_id !== prepared.session.cleanupHandle ||
      !exactCandidateAuthorityMatches(
        candidate,
        prepared.authorization,
        prepared.executionTokenSha256,
      ) ||
      candidate.sealed_receipt_canonical !== prepared.receiptCanonical ||
      !exactDigestMatches(candidate.sealed_receipt_sha256 ?? "", prepared.receiptSha256) ||
      !exactAuthorizationRowMatches(authorization, {
        candidateId: prepared.session.stagingHandle,
        request: prepared.authorization,
        authorizationId: prepared.authorization.authorizationId,
        authorizationRequestSha256: prepared.authorizationRequestSha256,
        executionTokenSha256: prepared.executionTokenSha256,
        proofTokenSha256: prepared.proofTokenSha256,
        expiresAtEpochMs: prepared.authorization.expiresAtEpochMs,
        state: "consumed",
      }) ||
      !exactTerminalMatches(terminal, prepared)
    ) {
      throw conflict("Restore-v3 sealed response replay is divergent", cause);
    }
    let durableReceipt: AgentBackupRestoreV3CandidateReceipt;
    try {
      durableReceipt = parseAgentBackupRestoreV3CandidateReceipt(
        JSON.parse(terminal.sealed_receipt_canonical ?? ""),
      );
    } catch (parseCause) {
      throw conflict("Restore-v3 sealed response replay is not canonical JSON", parseCause);
    }
    if (
      canonicalizeAgentBackupRestoreV3CandidateReceipt(durableReceipt) !== prepared.receiptCanonical
    ) {
      throw conflict("Restore-v3 sealed response replay changed canonical bytes", cause);
    }
    await applyAgentBackupRestoreV3TransactionDeadline(
      tx,
      boundedControl,
      "Restore-v3 candidate seal replay",
    );
    return durableReceipt;
  });
}

async function readExactSealedReceipt(
  prepared: PreparedSeal,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  cause: unknown,
  forceFreshControl = false,
): Promise<AgentBackupRestoreV3CandidateReceipt | null> {
  return readExactSealedReceiptSnapshot(
    prepared,
    recoveryControl(control, cause, forceFreshControl),
    cause,
  );
}

async function waitForExactSealedReceipt(
  prepared: PreparedSeal,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  cause: unknown,
): Promise<AgentBackupRestoreV3CandidateReceipt | null> {
  const boundedControl = recoveryControl(control, cause, true);
  while (Date.now() < boundedControl.deadlineEpochMs) {
    try {
      const exact = await readExactSealedReceiptSnapshot(prepared, boundedControl, cause);
      if (exact) return exact;
    } catch (replayCause) {
      if (replayCause instanceof AgentBackupRestoreV3CandidateSealConflictError) {
        throw replayCause;
      }
      const sqlState = agentBackupRestoreV3DatabaseSqlState(replayCause);
      if (
        Date.now() >= boundedControl.deadlineEpochMs ||
        (replayCause instanceof DOMException && replayCause.name === "AbortError") ||
        sqlState === "55P03" ||
        sqlState === "57014"
      ) {
        return null;
      }
      if (!isCandidateSealCommitAmbiguous(replayCause)) throw replayCause;
    }
    const remainingMs = boundedControl.deadlineEpochMs - Date.now();
    if (remainingMs <= 0) return null;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(AMBIGUOUS_COMMIT_RECOVERY_POLL_MS, remainingMs));
    });
  }
  return null;
}

async function replayExactSealedReceiptOrThrow(
  prepared: PreparedSeal,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  cause: unknown,
): Promise<AgentBackupRestoreV3CandidateReceipt> {
  const exact = await waitForExactSealedReceipt(prepared, control, cause);
  if (exact) return exact;
  throw cause;
}

/**
 * Append the one terminal seal command. Exact retries recover only the byte-
 * identical durable terminal proof from PRIMARY, never current mutable state.
 */
export function sealAgentBackupRestoreV3Candidate(
  sessionInput: Readonly<AgentBackupRestoreV3StagingSession>,
  receiptInput: Readonly<AgentBackupRestoreV3CandidateReceipt>,
  authorizationInput: Readonly<AgentBackupRestoreV3CandidateSealAuthorization>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<AgentBackupRestoreV3CandidateReceipt> {
  const operationControl = snapshotAgentBackupRestoreV3OperationControl(control);
  const prepared = prepareSeal(sessionInput, receiptInput, authorizationInput);
  try {
    assertAgentBackupRestoreV3OperationControl(operationControl, "Restore-v3 candidate seal");
  } catch (cause) {
    // An inactive but otherwise valid control may only reconcile an already-
    // committed exact seal. It never enters the mutating transaction below.
    if (!isValidInactiveControl(operationControl)) throw cause;
    return replayExactSealedReceiptOrThrow(prepared, operationControl, cause);
  }
  return sealPreparedCandidate(prepared, operationControl);
}

async function sealPreparedCandidate(
  prepared: PreparedSeal,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<AgentBackupRestoreV3CandidateReceipt> {
  try {
    await dbWrite.transaction(async (tx) => {
      await applyAgentBackupRestoreV3TransactionDeadline(tx, control, "Restore-v3 candidate seal");
      // These reads do not lock. The terminal INSERT trigger alone owns every
      // mutable authority lock and atomically consumes the proof plus candidate.
      const [candidate] = await tx
        .select()
        .from(agentBackupRestoreV3Candidates)
        .where(eq(agentBackupRestoreV3Candidates.id, prepared.session.stagingHandle))
        .limit(1);
      await applyAgentBackupRestoreV3TransactionDeadline(tx, control, "Restore-v3 candidate seal");
      const [authorization] = await tx
        .select()
        .from(agentBackupRestoreV3CandidateSealAuthorizations)
        .where(
          eq(
            agentBackupRestoreV3CandidateSealAuthorizations.id,
            prepared.authorization.authorizationId,
          ),
        )
        .limit(1);
      const request = prepared.authorization;
      if (
        !candidate ||
        candidate.state !== "active" ||
        candidate.cleanup_outbox_id !== prepared.session.cleanupHandle ||
        !exactCandidateAuthorityMatches(candidate, request, prepared.executionTokenSha256) ||
        !authorization ||
        !exactAuthorizationRowMatches(authorization, {
          candidateId: prepared.session.stagingHandle,
          request,
          authorizationId: prepared.authorization.authorizationId,
          authorizationRequestSha256: prepared.authorizationRequestSha256,
          executionTokenSha256: prepared.executionTokenSha256,
          proofTokenSha256: prepared.proofTokenSha256,
          expiresAtEpochMs: prepared.authorization.expiresAtEpochMs,
          state: "active",
        })
      ) {
        throw conflict("Restore-v3 seal lacks its exact active candidate authorization");
      }
      await applyAgentBackupRestoreV3TransactionDeadline(tx, control, "Restore-v3 candidate seal");
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (databaseNow.getTime() >= prepared.authorization.expiresAtEpochMs) {
        throw conflict("Restore-v3 seal authorization is expired");
      }
      await applyAgentBackupRestoreV3TransactionDeadline(tx, control, "Restore-v3 candidate seal");
      await tx.insert(agentBackupRestoreV3CandidateTerminalCommands).values({
        id: prepared.terminalCommandId,
        candidate_id: prepared.session.stagingHandle,
        organization_id: prepared.authorization.authority.organizationId,
        agent_id: prepared.authorization.authority.agentId,
        backup_id: prepared.authorization.authority.backupId,
        restore_attempt_id: prepared.session.restoreAttemptId,
        operation_id: prepared.session.operationId,
        execution_token_sha256: prepared.executionTokenSha256,
        command_kind: "seal",
        authorization_id: prepared.authorization.authorizationId,
        proof_token_sha256: prepared.proofTokenSha256,
        sealed_receipt_canonical: prepared.receiptCanonical,
        sealed_receipt_sha256: prepared.receiptSha256,
        command_sha256: prepared.terminalCommandSha256,
      });
      await applyAgentBackupRestoreV3TransactionDeadline(tx, control, "Restore-v3 candidate seal");
    });
    return prepared.receipt;
  } catch (cause) {
    // A timeout/cancellation can race the COMMIT acknowledgement. Reconcile
    // once from PRIMARY under a fresh read-only budget before classifying the
    // original failure; absence still preserves the original fail-closed error.
    const exact = isCandidateSealCommitAmbiguous(cause)
      ? await waitForExactSealedReceipt(prepared, control, cause)
      : await readExactSealedReceipt(prepared, control, cause, true);
    if (exact) return exact;
    throwIfAgentBackupRestoreV3DatabaseDeadline(cause, "Restore-v3 candidate seal");
    throw cause;
  }
}

/** Pre-bind a process-held one-shot proof to the first exact authorization request. */
export function createAgentBackupRestoreV3CandidateSealAuthority(): AgentBackupRestoreV3CandidateSealAuthority {
  return new CandidateSealAuthorityRepository();
}
