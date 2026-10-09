/**
 * Replay-safe controller methods that turn a sealed restore candidate into a
 * bootable committed generation inside the exact restore container: private
 * root preparation, generation prepare+commit, and the boot-grant handoff.
 * Every method derives paths from the attempt id and proves the identities the
 * coordinator recorded; none boots a runtime or authorizes routing.
 */

import { createHash } from "node:crypto";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/contracts";
import type {
  AgentBackupRestoreV3CommittedGeneration,
  AgentBackupRestoreV3ContainerRoots,
  AgentBackupRestoreV3ControllerRequest,
  AgentBackupRestoreV3ControllerResponse,
  AgentBackupRestoreV3RootIdentities,
} from "@elizaos/contracts/node";
import {
  AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS,
  AgentBackupRestoreV3ControllerResponseSchema,
  agentBackupRestoreV3TokenSha256,
  canonicalizeAgentBackupRestoreV3ServingValue,
} from "@elizaos/contracts/node";
import { assembleAgentBackupRestoreV3Candidate } from "./agent-backup-restore-v3-candidate-assembly";
import {
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { internalCleanupControl } from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import {
  type AgentBackupRestoreV3PreparedGenerationReceipt,
  prepareAgentBackupRestoreV3Generation,
} from "./agent-backup-restore-v3-generation";
import { commitAgentBackupRestoreV3Generation } from "./agent-backup-restore-v3-generation-commit";
import {
  ensurePrivateDirectory,
  inspectPrivateDirectory,
  inspectServingDataRoot,
  readPrivateFile,
  sameServingIdentity,
  writePrivateFileAtomic,
} from "./agent-backup-restore-v3-serving-files";
import {
  RESTORE_V3_BOOT_GRANT_CONSUMED_FILE,
  RESTORE_V3_BOOT_GRANT_FILE,
  servingDataRoot,
  servingError,
} from "./agent-backup-restore-v3-serving-wire";

const GENERATION_LOCK = ".restore-v3-generation.lock";
const PREPARED_MARKER = ".restore-v3-generation-prepared.json";
const INTENT_MARKER = ".restore-v3-generation-commit-intent.json";
const MARKER_LIMIT = { maximumBytes: 16 * 1024 };

export interface AgentBackupRestoreV3ServingControllerOptions {
  readonly roots: AgentBackupRestoreV3ContainerRoots;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  readonly testOnlyAllowNonLinuxFdEmulation?: boolean;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertActive(control: Readonly<AgentBackupRestoreV3OperationControl>) {
  if (control.signal.aborted || Date.now() >= control.deadlineEpochMs)
    throw servingError("INTERRUPTED");
}

function within(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

/**
 * Idempotently creates the five private roots and their private parents.
 * Replays re-prove and return the same identities.
 */
export async function prepareAgentBackupRestoreV3ServingRoots(
  roots: AgentBackupRestoreV3ContainerRoots,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<AgentBackupRestoreV3RootIdentities> {
  if (
    !within(roots.trustedRoot, roots.attemptRoot) ||
    !within(roots.generationTrustedRoot, roots.generationRoot) ||
    within(roots.trustedRoot, roots.runtimeRoot) ||
    within(roots.generationTrustedRoot, roots.runtimeRoot)
  )
    throw servingError("ROOT_LAYOUT_INVALID");
  const dataRoot = servingDataRoot(roots);
  assertActive(control);
  await inspectServingDataRoot(dataRoot);
  const base = `${dataRoot}/.restore-v3`;
  const ordered = [
    base,
    `${base}/candidate`,
    `${base}/generation`,
    `${base}/runtime`,
    roots.trustedRoot,
    roots.attemptRoot,
    roots.generationTrustedRoot,
    roots.generationRoot,
    roots.runtimeRoot,
  ];
  const identities = new Map<
    string,
    Awaited<ReturnType<typeof ensurePrivateDirectory>>
  >();
  for (const directory of ordered) {
    assertActive(control);
    identities.set(directory, await ensurePrivateDirectory(directory));
  }
  // Re-prove every ancestor after creation so a swapped parent cannot hide.
  for (const directory of ordered) {
    const again = await inspectPrivateDirectory(directory);
    const first = identities.get(directory);
    if (!first || !sameServingIdentity(first, again))
      throw servingError("ROOT_CHANGED");
  }
  assertActive(control);
  const get = (directory: string) => {
    const identity = identities.get(directory);
    if (!identity) throw servingError("ROOT_CHANGED");
    return identity;
  };
  return Object.freeze({
    trustedRootIdentity: get(roots.trustedRoot),
    attemptRootIdentity: get(roots.attemptRoot),
    generationTrustedRootIdentity: get(roots.generationTrustedRoot),
    generationRootIdentity: get(roots.generationRoot),
    runtimeRootIdentity: get(roots.runtimeRoot),
  });
}

async function openFs(
  trustedRoot: string,
  attemptRoot: string,
  options: AgentBackupRestoreV3ServingControllerOptions,
): Promise<AgentBackupRestoreV3CandidateFs> {
  return openAgentBackupRestoreV3CandidateFs({
    trustedRoot,
    attemptRoot,
    control: options.control,
    ...(options.testOnlyAllowNonLinuxFdEmulation
      ? { testOnlyAllowNonLinuxFdEmulation: true as const }
      : {}),
  });
}

/**
 * Prepares then commits the generation. A retry after a lost response returns
 * the same handoff: before the commit intent exists the prepare step replays
 * from its own marker; afterwards the prepared layout has been moved, so the
 * durable prepared receipt is re-bound to the exact candidate assembly instead.
 */
export async function commitAgentBackupRestoreV3ServingGeneration(
  request: Extract<
    AgentBackupRestoreV3ControllerRequest,
    { method: "commitGeneration" }
  >,
  options: AgentBackupRestoreV3ServingControllerOptions,
): Promise<AgentBackupRestoreV3CommittedGeneration> {
  const { roots, control } = options;
  if (
    request.session.restoreAttemptId !== request.restoreAttemptId ||
    request.receipt.restoreAttemptId !== request.restoreAttemptId ||
    request.receipt.operationId !== request.session.operationId
  )
    throw servingError("AUTHORITY_MISMATCH");
  const runtimeRootIdentity = await inspectPrivateDirectory(roots.runtimeRoot);
  if (
    !sameServingIdentity(runtimeRootIdentity, request.roots.runtimeRootIdentity)
  )
    throw servingError("ROOT_CHANGED");
  const candidateFs = await openFs(
    roots.trustedRoot,
    roots.attemptRoot,
    options,
  );
  try {
    const generationFs = await openFs(
      roots.generationTrustedRoot,
      roots.generationRoot,
      options,
    );
    try {
      if (
        !sameServingIdentity(
          candidateFs.trustedRootIdentity,
          request.roots.trustedRootIdentity,
        ) ||
        !sameServingIdentity(
          candidateFs.attemptRootIdentity,
          request.roots.attemptRootIdentity,
        ) ||
        !sameServingIdentity(
          generationFs.trustedRootIdentity,
          request.roots.generationTrustedRootIdentity,
        ) ||
        !sameServingIdentity(
          generationFs.attemptRootIdentity,
          request.roots.generationRootIdentity,
        )
      )
        throw servingError("ROOT_CHANGED");
      const assemblyInput = {
        candidateFs,
        session: request.session,
        receipt: request.receipt,
        control,
      };
      const lock = await generationFs.acquireLock(GENERATION_LOCK, control);
      let stored: unknown;
      let intent: unknown;
      try {
        stored = await generationFs.readDurableJson(
          PREPARED_MARKER,
          MARKER_LIMIT,
          control,
          lock,
        );
        intent = await generationFs.readDurableJson(
          INTENT_MARKER,
          MARKER_LIMIT,
          control,
          lock,
        );
      } finally {
        await lock.release(internalCleanupControl());
      }
      let preparedReceipt: Readonly<AgentBackupRestoreV3PreparedGenerationReceipt>;
      if (intent === null) {
        preparedReceipt = await prepareAgentBackupRestoreV3Generation({
          ...assemblyInput,
          generationFs,
        });
      } else {
        if (stored === null || typeof stored !== "object")
          throw servingError("REPLAY_CONFLICT");
        const replayed =
          stored as AgentBackupRestoreV3PreparedGenerationReceipt;
        const sourceLock = await candidateFs.acquireLock(
          GENERATION_LOCK,
          control,
        );
        try {
          const assembly = await assembleAgentBackupRestoreV3Candidate(
            assemblyInput,
            sourceLock,
          );
          const inventory = await candidateFs.inspectFileTree(
            "components",
            control,
            sourceLock,
          );
          if (
            replayed.assemblySha256 !== assembly.assemblySha256 ||
            replayed.sourceTreeSha256 !== inventory.sha256
          )
            throw servingError("REPLAY_CONFLICT");
        } finally {
          await sourceLock.release(internalCleanupControl());
        }
        preparedReceipt = replayed;
      }
      const committed = await commitAgentBackupRestoreV3Generation({
        generationFs,
        preparedReceipt,
        runtimeRoot: roots.runtimeRoot,
        runtimeRootIdentity,
        control,
      });
      if (
        committed.preparedReceiptSha256 !== preparedReceipt.receiptSha256 ||
        !sameServingIdentity(committed.runtimeRootIdentity, runtimeRootIdentity)
      )
        throw servingError("RECEIPT_CONFLICT");
      return Object.freeze({
        preparedReceipt: JSON.parse(
          candidateFsCanonicalJson(preparedReceipt),
        ) as Record<string, unknown>,
        preparedReceiptSha256: preparedReceipt.receiptSha256,
        committedReceiptSha256: committed.receiptSha256,
        runtimeRootIdentity,
        generationTrustedRootIdentity: generationFs.trustedRootIdentity,
        generationRootIdentity: generationFs.attemptRootIdentity,
      });
    } finally {
      await generationFs.close();
    }
  } finally {
    await candidateFs.close();
  }
}

/**
 * Durably hands the boot grant to the runtime root. The identical grant
 * replays to the same digest (also after the runtime consumed it); any other
 * grant for this attempt is rejected because the coordinator never re-grants.
 */
export async function writeAgentBackupRestoreV3ServingBootGrant(
  request: Extract<
    AgentBackupRestoreV3ControllerRequest,
    { method: "writeBootGrant" }
  >,
  options: AgentBackupRestoreV3ServingControllerOptions,
): Promise<string> {
  const { grant } = request;
  if (
    grant.agentId !== request.agentId ||
    grant.restoreAttemptId !== request.restoreAttemptId
  )
    throw servingError("GRANT_MISMATCH");
  if (agentBackupRestoreV3TokenSha256(grant.token) !== grant.tokenSha256)
    throw servingError("GRANT_TOKEN_MISMATCH");
  const runtimeRoot = options.roots.runtimeRoot;
  const identity = await inspectPrivateDirectory(runtimeRoot);
  if (!sameServingIdentity(identity, grant.generation.runtimeRootIdentity))
    throw servingError("ROOT_CHANGED");
  const canonical = Buffer.from(
    canonicalizeAgentBackupRestoreV3ServingValue(grant),
    "utf8",
  );
  try {
    const grantSha256 = sha256Hex(canonical);
    const limit = AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS.requestBytes;
    const existing = await readPrivateFile(
      runtimeRoot,
      RESTORE_V3_BOOT_GRANT_FILE,
      limit,
    );
    if (existing) {
      try {
        if (!existing.equals(canonical)) throw servingError("GRANT_CONFLICT");
        return grantSha256;
      } finally {
        existing.fill(0);
      }
    }
    const consumed = await readPrivateFile(
      runtimeRoot,
      RESTORE_V3_BOOT_GRANT_CONSUMED_FILE,
      4096,
    );
    if (consumed) {
      const record = parseConsumedGrant(consumed);
      if (record !== grantSha256) throw servingError("GRANT_CONSUMED");
      return grantSha256;
    }
    assertActive(options.control);
    await writePrivateFileAtomic(
      runtimeRoot,
      RESTORE_V3_BOOT_GRANT_FILE,
      canonical,
    );
    return grantSha256;
  } finally {
    canonical.fill(0);
  }
}

/** Canonical record of the grant digest a booted runtime consumed. */
export function consumedGrantRecord(grantSha256: string): string {
  return canonicalizeAgentBackupRestoreV3ServingValue({
    version: 1,
    format: "elizaos.agent-backup.restore-v3-boot-grant-consumed.v1",
    grantSha256,
  });
}

function parseConsumedGrant(bytes: Buffer): string {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as {
      grantSha256?: unknown;
    };
    const digest = value.grantSha256;
    if (
      typeof digest !== "string" ||
      bytes.toString("utf8") !== consumedGrantRecord(digest)
    )
      throw servingError("GRANT_CONSUMED");
    return digest;
  } catch (cause) {
    // error-policy:J1 A malformed consumption record is never a fresh state.
    throw servingError("GRANT_CONSUMED", cause);
  }
}

/** Dispatches one parsed controller request to its replay-safe method. */
export async function runAgentBackupRestoreV3ServingController(
  request: AgentBackupRestoreV3ControllerRequest,
  options: AgentBackupRestoreV3ServingControllerOptions,
): Promise<AgentBackupRestoreV3ControllerResponse> {
  assertActive(options.control);
  let response: AgentBackupRestoreV3ControllerResponse;
  if (request.method === "prepareRoots") {
    response = {
      method: "prepareRoots",
      roots: await prepareAgentBackupRestoreV3ServingRoots(
        options.roots,
        options.control,
      ),
    };
  } else if (request.method === "commitGeneration") {
    response = {
      method: "commitGeneration",
      generation: await commitAgentBackupRestoreV3ServingGeneration(
        request,
        options,
      ),
    };
  } else {
    response = {
      method: "writeBootGrant",
      grantSha256: await writeAgentBackupRestoreV3ServingBootGrant(
        request,
        options,
      ),
    };
  }
  assertActive(options.control);
  return AgentBackupRestoreV3ControllerResponseSchema.parse(response);
}
