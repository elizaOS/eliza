/**
 * Commits a prepared manifest-v3 layout to its exact runtime directory.
 * An immutable intent precedes the same-filesystem rename; a separate durable
 * receipt follows both parent fsyncs. Lost responses reconcile by inode, and
 * terminal replay never rewrites or rehashes state already used by a runtime.
 * This local filesystem handoff is not PRIMARY authorization, a boot grant,
 * signed readiness, funding approval, or permission to publish routes.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import { z } from "zod";
import {
  type AgentBackupRestoreV3CandidateFs,
  type AgentBackupRestoreV3CandidateFsIdentity,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import {
  internalCleanupControl,
  snapshotOperationControl,
  snapshotOwnDataRecord,
} from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import type { AgentBackupRestoreV3PreparedGenerationReceipt } from "./agent-backup-restore-v3-generation";

const PREPARED = ".restore-v3-generation-prepared.json";
const INTENT = ".restore-v3-generation-commit-intent.json";
const COMMITTED = ".restore-v3-generation-committed.json";
const LIMIT = { maximumBytes: 16 * 1024 };
const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Identity = z.strictObject({
  device: z.string().regex(/^(0|[1-9][0-9]*)$/),
  inode: z.string().regex(/^[1-9][0-9]*$/),
});
const Prepared = z.strictObject({
  version: z.literal(1),
  format: z.literal("elizaos.agent-backup.restore-v3-generation-prepared.v1"),
  assemblySha256: Sha,
  sourceTreeSha256: Sha,
  targetRoot: Identity,
  paths: z.strictObject({
    character: z.literal("generation/character/character.json"),
    database: z.literal("generation/database"),
    state: z.literal("generation/state"),
  }),
  treeSha256: Sha,
  files: z.number().int().safe().positive(),
  directories: z.number().int().safe().positive(),
  bytes: z.number().int().safe().positive(),
  receiptSha256: Sha,
});
const Receipt = z.strictObject({
  version: z.literal(1),
  format: z.literal("elizaos.agent-backup.restore-v3-generation-committed.v1"),
  preparedReceiptSha256: Sha,
  assemblySha256: Sha,
  runtimeRoot: z.string(),
  runtimeRootIdentity: Identity,
  generationIdentity: Identity,
  paths: z.strictObject({
    character: z.string(),
    database: z.string(),
    state: z.string(),
  }),
  receiptSha256: Sha,
});

export type AgentBackupRestoreV3CommittedGenerationReceipt = Readonly<
  z.infer<typeof Receipt>
>;

export interface AgentBackupRestoreV3GenerationCommitInput {
  readonly generationFs: AgentBackupRestoreV3CandidateFs;
  readonly preparedReceipt: AgentBackupRestoreV3PreparedGenerationReceipt;
  /** Existing private controller-owned parent outside all quarantine roots. */
  readonly runtimeRoot: string;
  readonly runtimeRootIdentity: AgentBackupRestoreV3CandidateFsIdentity;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
}

function fail(code: string): never {
  throw new ElizaError("Exact generation commit is not proven", {
    code: `AGENT_BACKUP_RESTORE_V3_GENERATION_COMMIT_${code}`,
  });
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(candidateFsCanonicalJson(value))
    .digest("hex");
}
function equal(left: unknown, right: unknown): boolean {
  return candidateFsCanonicalJson(left) === candidateFsCanonicalJson(right);
}

export async function commitAgentBackupRestoreV3Generation(
  input: Readonly<AgentBackupRestoreV3GenerationCommitInput>,
): Promise<AgentBackupRestoreV3CommittedGenerationReceipt> {
  const keys = [
    "generationFs",
    "preparedReceipt",
    "runtimeRoot",
    "runtimeRootIdentity",
    "control",
  ];
  const exact = snapshotOwnDataRecord(
    input,
    keys,
    keys,
    "AGENT_BACKUP_RESTORE_V3_GENERATION_COMMIT_INPUT_INVALID",
    "Generation commit requires exact data properties",
  );
  const candidate = exact.generationFs;
  if (!isAgentBackupRestoreV3CandidateFs(candidate)) fail("INPUT_INVALID");
  const prepared = Prepared.parse(
    JSON.parse(candidateFsCanonicalJson(exact.preparedReceipt)),
  );
  const runtimeRoot = exact.runtimeRoot;
  const runtimeRootIdentity = Identity.parse(
    JSON.parse(candidateFsCanonicalJson(exact.runtimeRootIdentity)),
  );
  const control = snapshotOperationControl(
    exact.control as AgentBackupRestoreV3OperationControl,
  );
  if (
    typeof runtimeRoot !== "string" ||
    !path.isAbsolute(runtimeRoot) ||
    path.resolve(runtimeRoot) !== runtimeRoot
  )
    fail("INPUT_INVALID");
  const { receiptSha256, ...preparedBody } = prepared;
  if (
    digest(preparedBody) !== receiptSha256 ||
    !equal(prepared.targetRoot, candidate.attemptRootIdentity)
  )
    fail("PREPARED_CONFLICT");
  const generationPath = path.join(runtimeRoot, `generation-${receiptSha256}`);
  const authority = {
    version: 1 as const,
    format: "elizaos.agent-backup.restore-v3-generation-committed.v1" as const,
    preparedReceiptSha256: receiptSha256,
    assemblySha256: prepared.assemblySha256,
    runtimeRoot,
    runtimeRootIdentity: Object.freeze(runtimeRootIdentity),
    paths: Object.freeze({
      character: path.join(generationPath, "character/character.json"),
      database: path.join(generationPath, "database"),
      state: path.join(generationPath, "state"),
    }),
  };
  const lock = await candidate.acquireLock(
    ".restore-v3-generation.lock",
    control,
  );
  try {
    if (
      !equal(
        await candidate.readDurableJson(PREPARED, LIMIT, control, lock),
        prepared,
      )
    )
      fail("PREPARED_CONFLICT");
    const committed = await candidate.readDurableJson(
      COMMITTED,
      LIMIT,
      control,
      lock,
    );
    const retained = await candidate.readDurableJson(
      INTENT,
      LIMIT,
      control,
      lock,
    );
    let receipt: AgentBackupRestoreV3CommittedGenerationReceipt;
    if (retained !== null) {
      const parsed = Receipt.parse(retained);
      const body = {
        ...authority,
        generationIdentity: Object.freeze(parsed.generationIdentity),
      };
      receipt = Object.freeze({ ...body, receiptSha256: digest(body) });
      if (!equal(retained, receipt)) fail("INTENT_CONFLICT");
    } else {
      if (committed !== null) fail("INTENT_MISSING");
      const tree = await candidate.inspectFileTree("generation", control, lock);
      if (
        tree.sha256 !== prepared.treeSha256 ||
        tree.files !== prepared.files ||
        tree.directories !== prepared.directories ||
        tree.bytes !== prepared.bytes
      )
        fail("TREE_CHANGED");
      const body = {
        ...authority,
        generationIdentity: Object.freeze({
          device: tree.device,
          inode: tree.inode,
        }),
      };
      receipt = Object.freeze({ ...body, receiptSha256: digest(body) });
      await candidate.settleGenerationPromotion(
        {
          ...promotionAuthority(receipt),
          treeSha256: prepared.treeSha256,
          phase: "prepared",
        },
        control,
        lock,
      );
      await candidate.publishDurableJson(INTENT, receipt, LIMIT, control, lock);
    }
    if (committed !== null && !equal(committed, receipt))
      fail("RECEIPT_CONFLICT");
    await candidate.settleGenerationPromotion(
      {
        ...promotionAuthority(receipt),
        treeSha256: prepared.treeSha256,
        phase: committed === null ? "promoting" : "committed",
      },
      control,
      lock,
    );
    if (committed === null) {
      await candidate.publishDurableJson(
        COMMITTED,
        receipt,
        LIMIT,
        control,
        lock,
      );
      if (
        !equal(
          await candidate.readDurableJson(COMMITTED, LIMIT, control, lock),
          receipt,
        )
      )
        fail("RECEIPT_CONFLICT");
    }
    return receipt;
  } finally {
    await lock.release(internalCleanupControl());
  }
}

function promotionAuthority(
  receipt: AgentBackupRestoreV3CommittedGenerationReceipt,
) {
  return {
    runtimeRoot: receipt.runtimeRoot,
    runtimeRootIdentity: receipt.runtimeRootIdentity,
    generationIdentity: receipt.generationIdentity,
    preparedReceiptSha256: receipt.preparedReceiptSha256,
  };
}
