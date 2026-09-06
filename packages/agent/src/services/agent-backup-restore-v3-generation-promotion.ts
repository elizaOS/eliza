/**
 * Settles a journaled generation rename outside the private candidate roots.
 * The owning commit service retains the candidate inode lock and publishes an
 * intent before calling this boundary. The digest-qualified destination belongs
 * only to that candidate; its parent must remain inaccessible to workloads and
 * non-cooperating writers. A committed replay inspects identity, never live data.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import {
  inspectCandidateFsFileTree,
  inspectPendingPromotedFileTree,
} from "./agent-backup-restore-v3-candidate-file-tree";
import {
  type AgentBackupRestoreV3CandidateFsControl,
  type AgentBackupRestoreV3CandidateFsIdentity,
  type AgentBackupRestoreV3CandidateFsLock,
  type CandidateFsExactStats,
  candidateFsError,
  candidateFsIdentity,
  controlled,
  fileStatExact,
  isErrno,
  lstatExact,
  requirePrivateDirectory,
  resolveDirectoryAuthority,
  runAllBoundedInternalCleanup,
  sameIdentity,
  snapshotOperationControl,
  snapshotOwnDataRecord,
} from "./agent-backup-restore-v3-candidate-fs-control";

export interface AgentBackupRestoreV3GenerationPromotion {
  readonly runtimeRoot: string;
  readonly runtimeRootIdentity: AgentBackupRestoreV3CandidateFsIdentity;
  readonly generationIdentity: AgentBackupRestoreV3CandidateFsIdentity;
  readonly preparedReceiptSha256: string;
  readonly treeSha256: string;
  readonly phase: "prepared" | "promoting" | "committed";
}

function fail(): never {
  candidateFsError(
    "AGENT_BACKUP_RESTORE_V3_GENERATION_PROMOTION_CONFLICT",
    "Generation promotion requires its exact journaled source and destination",
  );
}

function identity(value: unknown): AgentBackupRestoreV3CandidateFsIdentity {
  const record = snapshotOwnDataRecord(
    value,
    ["device", "inode"],
    ["device", "inode"],
    "AGENT_BACKUP_RESTORE_V3_GENERATION_PROMOTION_CONFLICT",
    "Generation promotion requires an exact filesystem identity",
  );
  if (
    typeof record.device !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(record.device) ||
    typeof record.inode !== "string" ||
    !/^[1-9][0-9]*$/.test(record.inode)
  )
    fail();
  return Object.freeze({ device: record.device, inode: record.inode });
}

function matches(
  stats: CandidateFsExactStats,
  expected: AgentBackupRestoreV3CandidateFsIdentity,
): boolean {
  const actual = candidateFsIdentity(stats);
  return actual.device === expected.device && actual.inode === expected.inode;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

async function optionalStat(
  name: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
) {
  try {
    return await controlled(() => lstatExact(name), control);
  } catch (cause) {
    // error-policy:J3 Only an absent exact entry is a pre-rename state.
    if (isErrno(cause, "ENOENT")) return null;
    throw cause;
  }
}

export async function settleCandidateGenerationPromotion(
  source: AgentBackupRestoreV3CandidateFsControl,
  value: Readonly<AgentBackupRestoreV3GenerationPromotion>,
  controlValue: Readonly<AgentBackupRestoreV3OperationControl>,
  lock: AgentBackupRestoreV3CandidateFsLock,
): Promise<void> {
  const keys = [
    "runtimeRoot",
    "runtimeRootIdentity",
    "generationIdentity",
    "preparedReceiptSha256",
    "treeSha256",
    "phase",
  ];
  const exact = snapshotOwnDataRecord(
    value,
    keys,
    keys,
    "AGENT_BACKUP_RESTORE_V3_GENERATION_PROMOTION_CONFLICT",
    "Generation promotion requires an exact data-property contract",
  );
  const runtimeRoot = exact.runtimeRoot;
  const parentIdentity = identity(exact.runtimeRootIdentity);
  const generationIdentity = identity(exact.generationIdentity);
  const digest = exact.preparedReceiptSha256;
  const treeSha256 = exact.treeSha256;
  if (
    typeof runtimeRoot !== "string" ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    typeof treeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(treeSha256) ||
    !["prepared", "promoting", "committed"].includes(exact.phase as string)
  )
    fail();
  const phase = exact.phase;
  if (
    contains(source.trustedRoot, runtimeRoot) ||
    contains(runtimeRoot, source.trustedRoot)
  )
    fail();
  const control = snapshotOperationControl(controlValue);
  await source.assertLockHeld(lock, control);
  const releaseUse = source.beginLockUse(lock);
  let parent: Awaited<ReturnType<typeof resolveDirectoryAuthority>> | undefined;
  try {
    parent = await resolveDirectoryAuthority(
      runtimeRoot,
      "runtimeRoot",
      control,
      source.attemptAuthority.testOnlyPathnameEmulation,
    );
    const authority = parent;
    if (
      !matches(authority.stats, parentIdentity) ||
      parentIdentity.device !== generationIdentity.device
    )
      fail();
    const assertParent = async () => {
      await source.assertLockHeld(lock, control);
      const [opened, visible, real] = await controlled(
        () =>
          Promise.all([
            fileStatExact(authority.handle),
            lstatExact(runtimeRoot),
            fs.realpath(runtimeRoot),
          ]),
        control,
      );
      requirePrivateDirectory(
        opened,
        "Runtime generation parent is no longer private",
      );
      if (
        real !== runtimeRoot ||
        !matches(opened, parentIdentity) ||
        !sameIdentity(opened, visible)
      )
        fail();
    };
    const origin = source.directPath("generation", "generation");
    const destination = path.join(authority.anchor, `generation-${digest}`);
    await assertParent();
    const [before, target] = await Promise.all([
      optionalStat(origin, control),
      optionalStat(destination, control),
    ]);
    if (before) {
      requirePrivateDirectory(
        before,
        "Prepared generation is no longer private",
      );
      if (
        phase === "committed" ||
        target ||
        !matches(before, generationIdentity)
      )
        fail();
      if (
        (await inspectCandidateFsFileTree(source, "generation", control, lock))
          .sha256 !== treeSha256
      )
        fail();
      if (phase === "prepared") return;
      // Digest includes the source authority's inode. A different candidate
      // cannot own this destination; same-candidate callers share this lock.
      // The runtime parent must exclude all other writers until commit.
      await controlled(() => fs.rename(origin, destination), control);
    } else if (
      phase === "prepared" ||
      !target ||
      !matches(target, generationIdentity)
    ) {
      fail();
    }
    const after = await controlled(() => lstatExact(destination), control);
    requirePrivateDirectory(
      after,
      "Promoted generation is not a private directory",
    );
    if (
      !matches(after, generationIdentity) ||
      (await optionalStat(origin, control))
    )
      fail();
    await assertParent();
    if (phase !== "committed") {
      const targetAuthority = await resolveDirectoryAuthority(
        path.join(runtimeRoot, `generation-${digest}`),
        "promoted generation",
        control,
        authority.testOnlyPathnameEmulation,
      );
      try {
        if (!matches(targetAuthority.stats, generationIdentity)) fail();
        const tree = await inspectPendingPromotedFileTree(
          source,
          {
            handle: targetAuthority.handle,
            stats: targetAuthority.stats,
            anchor: targetAuthority.anchor,
            testPath: targetAuthority.path,
          },
          control,
          lock,
        );
        if (tree.sha256 !== treeSha256) fail();
      } finally {
        await runAllBoundedInternalCleanup([
          () => targetAuthority.handle.close(),
        ]);
      }
      // Reconcile both directory entries even after a rename response was lost.
      await controlled(() => authority.handle.sync(), control);
      await source.syncAttemptRoot(control);
      await assertParent();
      if (
        !matches(
          await controlled(() => lstatExact(destination), control),
          generationIdentity,
        ) ||
        (await optionalStat(origin, control))
      )
        fail();
    }
  } finally {
    const openedParent = parent;
    await runAllBoundedInternalCleanup([
      ...(openedParent ? [() => openedParent.handle.close()] : []),
      async () => releaseUse(),
    ]);
  }
}
