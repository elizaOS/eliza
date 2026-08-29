/**
 * Exercises the restore-v3 candidate filesystem boundary against real private
 * temporary directories, including replay, link attacks, pathname swaps,
 * deterministic proofs, and bounded volatile cleanup.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentBackupRestoreV3CandidateFs,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs.ts";

const roots = new Set<string>();
const candidates = new Set<AgentBackupRestoreV3CandidateFs>();
const OWNER_TOKEN = "owner-token-for-candidate-fs-tests";

function operationControl(signal = new AbortController().signal) {
  return {
    signal,
    deadlineEpochMs: Date.now() + 30_000,
  };
}

function platformTestOption() {
  return process.platform === "linux"
    ? {}
    : ({ testOnlyAllowNonLinuxFdEmulation: true as const } as const);
}

async function privateTemporaryRoot(prefix: string): Promise<string> {
  const realTemporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(realTemporaryRoot, prefix));
  await fs.chmod(root, 0o700);
  roots.add(root);
  return root;
}

async function fixture(): Promise<{
  candidate: AgentBackupRestoreV3CandidateFs;
  trustedRoot: string;
  attemptRoot: string;
}> {
  const trustedRoot = await privateTemporaryRoot("restore-v3-candidate-fs-");
  const attemptRoot = path.join(trustedRoot, "attempt");
  await fs.mkdir(attemptRoot, { mode: 0o700 });
  const candidate = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot,
    attemptRoot,
    control: operationControl(),
    ...platformTestOption(),
  });
  candidates.add(candidate);
  return { candidate, trustedRoot, attemptRoot };
}

async function writePrivateFile(filePath: string, bytes: Uint8Array | string) {
  await fs.writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
}

async function writeProofTree(
  attemptRoot: string,
  name: string,
  reverseCreationOrder: boolean,
): Promise<void> {
  const root = path.join(attemptRoot, name);
  const nested = path.join(root, "nested");
  await fs.mkdir(root, { mode: 0o700 });
  if (reverseCreationOrder) {
    await writePrivateFile(path.join(root, "z.txt"), "zeta");
    await fs.mkdir(nested, { mode: 0o700 });
    await writePrivateFile(path.join(nested, "b.bin"), Uint8Array.of(0, 1, 2));
    await writePrivateFile(path.join(root, "a.txt"), "alpha");
  } else {
    await writePrivateFile(path.join(root, "a.txt"), "alpha");
    await fs.mkdir(nested, { mode: 0o700 });
    await writePrivateFile(path.join(nested, "b.bin"), Uint8Array.of(0, 1, 2));
    await writePrivateFile(path.join(root, "z.txt"), "zeta");
  }
}

afterEach(async () => {
  const pendingCandidates = [...candidates];
  candidates.clear();
  await Promise.all(pendingCandidates.map((candidate) => candidate.close()));
  const pending = [...roots];
  roots.clear();
  await Promise.all(
    pending.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("restore-v3 candidate filesystem", () => {
  it("fails closed off Linux unless the explicit test emulation is enabled", async () => {
    if (process.platform === "linux") return;
    const trustedRoot = await privateTemporaryRoot(
      "restore-v3-candidate-platform-",
    );
    const attemptRoot = path.join(trustedRoot, "attempt");
    await fs.mkdir(attemptRoot, { mode: 0o700 });
    await expect(
      openAgentBackupRestoreV3CandidateFs({
        trustedRoot,
        attemptRoot,
        control: operationControl(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PLATFORM_UNSUPPORTED",
    });
  });

  it("binds canonical private roots and rejects escapes, links, and root swaps", async () => {
    const { candidate, trustedRoot, attemptRoot } = await fixture();
    const outsideRoot = await privateTemporaryRoot(
      "restore-v3-candidate-outside-",
    );
    const outsideAttempt = path.join(outsideRoot, "attempt");
    await fs.mkdir(outsideAttempt, { mode: 0o700 });

    await expect(
      openAgentBackupRestoreV3CandidateFs({
        trustedRoot,
        attemptRoot: outsideAttempt,
        control: operationControl(),
        ...platformTestOption(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PATH_FORBIDDEN",
    });
    await expect(
      openAgentBackupRestoreV3CandidateFs({
        trustedRoot: path.relative(process.cwd(), trustedRoot),
        attemptRoot,
        control: operationControl(),
        ...platformTestOption(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
    });

    const linkedAttempt = path.join(trustedRoot, "linked-attempt");
    await fs.symlink(outsideAttempt, linkedAttempt);
    await expect(
      openAgentBackupRestoreV3CandidateFs({
        trustedRoot,
        attemptRoot: linkedAttempt,
        control: operationControl(),
        ...platformTestOption(),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
    });

    const displacedAttempt = path.join(trustedRoot, "displaced-attempt");
    await fs.rename(attemptRoot, displacedAttempt);
    await fs.mkdir(attemptRoot, { mode: 0o700 });
    if (process.platform === "linux") {
      await expect(
        candidate.assertAuthority(operationControl()),
      ).resolves.toBeUndefined();
    } else {
      await expect(
        candidate.assertAuthority(operationControl()),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_CHANGED",
      });
    }
  });

  it("holds an inode-bound kernel lock across root rename and reacquisition", async () => {
    const { candidate, trustedRoot, attemptRoot } = await fixture();
    const control = operationControl();
    const lock = await candidate.acquireLock("candidate.lock", control);
    await expect(
      candidate.acquireLock("candidate.lock", control),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_BUSY",
    });
    await expect(
      candidate.publishDurableJson(
        "requires-lease.json",
        { locked: true },
        { maximumBytes: 256 },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_BUSY",
    });
    await expect(
      candidate.publishDurableJson(
        "requires-lease.json",
        { locked: true },
        { maximumBytes: 256 },
        control,
        lock,
      ),
    ).resolves.toMatchObject({ replayed: false });

    const displaced = path.join(trustedRoot, "attempt.displaced");
    await fs.rename(attemptRoot, displaced);
    await fs.mkdir(attemptRoot, { mode: 0o700 });
    const sameInode = await openAgentBackupRestoreV3CandidateFs({
      trustedRoot,
      attemptRoot: displaced,
      control,
      ...platformTestOption(),
    });
    await expect(
      sameInode.acquireLock("different-name.lock", control),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_BUSY",
    });
    await expect(fs.readdir(attemptRoot)).resolves.toEqual([]);
    await lock.release(control);
    const reacquired = await sameInode.acquireLock(
      "after-release.lock",
      control,
    );
    await reacquired.release(control);
    await sameInode.close();
  });

  it("never redirects a mutation into a replacement attempt root", async () => {
    const { candidate, trustedRoot, attemptRoot } = await fixture();
    const displaced = path.join(trustedRoot, "attempt-original");
    await fs.rename(attemptRoot, displaced);
    await fs.mkdir(attemptRoot, { mode: 0o700 });

    const publication = candidate.publishDurableJson(
      "bound.json",
      { bound: true },
      { maximumBytes: 256 },
      operationControl(),
    );
    if (process.platform === "linux") {
      await expect(publication).resolves.toMatchObject({ replayed: false });
      await expect(
        fs.readFile(path.join(displaced, "bound.json"), "utf8"),
      ).resolves.toBe('{"bound":true}\n');
    } else {
      await expect(publication).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_CHANGED",
      });
    }
    await expect(fs.readdir(attemptRoot)).resolves.toEqual([]);
  });

  it("writes fragmented payloads and proves replay from the bound descriptor", async () => {
    const { candidate, attemptRoot } = await fixture();
    const control = operationControl();
    const writer = await candidate.createPayload(
      "database.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    const mutable = Uint8Array.from(Buffer.from("abc"));
    const pendingWrite = writer.write(mutable, control);
    mutable.fill(0);
    await pendingWrite;
    await writer.write(Buffer.from("def"), control);
    const receipt = await writer.finalize(control);

    expect(receipt).toMatchObject({
      sizeBytes: 6,
      sha256: createHash("sha256").update("abcdef").digest("hex"),
    });
    await expect(
      candidate.provePayload(
        "database.payload",
        receipt,
        { maximumBytes: 64 },
        control,
      ),
    ).resolves.toEqual(receipt);
    await expect(
      candidate.provePayload(
        "database.payload",
        { ...receipt, sha256: "0".repeat(64) },
        { maximumBytes: 64 },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
    });

    const alias = path.join(attemptRoot, "database.payload.alias");
    await fs.link(path.join(attemptRoot, "database.payload"), alias);
    await expect(
      candidate.provePayload(
        "database.payload",
        receipt,
        { maximumBytes: 64 },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
    });
  });

  it("refuses payload symlinks, hardlinks, overflow, and pathname swaps", async () => {
    const { candidate, attemptRoot } = await fixture();
    const control = operationControl();
    const target = path.join(attemptRoot, "payload-target");
    await writePrivateFile(target, "target");
    await fs.symlink(target, path.join(attemptRoot, "linked.payload"));
    await expect(
      candidate.createPayload(
        "linked.payload",
        { maximumBytes: 32, ownerToken: OWNER_TOKEN },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
    });
    await fs.link(target, path.join(attemptRoot, "hardlinked.payload"));
    await expect(
      candidate.createPayload(
        "hardlinked.payload",
        { maximumBytes: 32, ownerToken: OWNER_TOKEN },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
    });

    const overflow = await candidate.createPayload(
      "overflow.payload",
      { maximumBytes: 3, ownerToken: OWNER_TOKEN },
      control,
    );
    expect(() => overflow.write(Buffer.from("four"), control)).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_LIMIT",
      }),
    );
    await overflow.close();

    const swapped = await candidate.createPayload(
      "swapped.payload",
      { maximumBytes: 32, ownerToken: OWNER_TOKEN },
      control,
    );
    await swapped.write(Buffer.from("seed"), control);
    const payloadPath = path.join(attemptRoot, "swapped.payload");
    await fs.rename(payloadPath, path.join(attemptRoot, "swapped.displaced"));
    await writePrivateFile(payloadPath, "seed");
    await expect(swapped.finalize(control)).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
    });
  });

  it("resumes only the exact payload owner after crash and lost response", async () => {
    const { candidate, attemptRoot } = await fixture();
    const control = operationControl();
    const first = await candidate.createPayload(
      "recoverable.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    await first.write(Buffer.from("abc"), control);
    await first.close();

    const resumed = await candidate.createPayload(
      "recoverable.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    expect(resumed.acknowledgedBytes).toBe(3);
    await resumed.write(Buffer.from("def"), control);
    const receipt = await resumed.finalize(control);

    const replay = await candidate.createPayload(
      "recoverable.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    expect(replay.acknowledgedBytes).toBe(6);
    await expect(replay.finalize(control)).resolves.toEqual(receipt);
    await expect(
      candidate.createPayload(
        "recoverable.payload",
        {
          maximumBytes: 64,
          ownerToken: "another-owner-token-for-candidate-fs-test",
        },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_CONFLICT",
    });

    const inodeBound = await candidate.createPayload(
      "inode-bound.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    await inodeBound.write(Buffer.from("owned"), control);
    await inodeBound.close();
    const inodePath = path.join(attemptRoot, "inode-bound.payload");
    await fs.rename(inodePath, path.join(attemptRoot, "inode-bound.displaced"));
    await writePrivateFile(inodePath, "owned");
    await expect(
      candidate.createPayload(
        "inode-bound.payload",
        { maximumBytes: 64, ownerToken: OWNER_TOKEN },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
    });
  });

  it("disposes the payload descriptor and inode lock after a late abort", async () => {
    const { candidate, trustedRoot, attemptRoot } = await fixture();
    const writer = await candidate.createPayload(
      "late-abort.payload",
      { maximumBytes: 256 * 1024, ownerToken: OWNER_TOKEN },
      operationControl(),
    );
    const controller = new AbortController();
    const pending = writer.write(
      Buffer.alloc(256 * 1024, 0x61),
      operationControl(controller.signal),
    );
    controller.abort(new Error("abort after write dispatch"));
    await expect(pending).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ABORTED",
    });

    const secondAuthority = await openAgentBackupRestoreV3CandidateFs({
      trustedRoot,
      attemptRoot,
      control: operationControl(),
      ...platformTestOption(),
    });
    const recovered = await secondAuthority.createPayload(
      "late-abort.payload",
      { maximumBytes: 256 * 1024, ownerToken: OWNER_TOKEN },
      operationControl(),
    );
    expect(recovered.acknowledgedBytes).toBeGreaterThanOrEqual(0);
    await recovered.close();
    await secondAuthority.close();
  });

  it("publishes canonical durable JSON with exact replay and stale-lock roll-forward", async () => {
    const { candidate, attemptRoot } = await fixture();
    const control = operationControl();
    const value = { z: 2, a: { enabled: true } };
    const expectedBytes = Buffer.from('{"a":{"enabled":true},"z":2}\n');
    const first = await candidate.publishDurableJson(
      "receipt.json",
      value,
      { maximumBytes: 1_024 },
      control,
    );
    expect(first).toEqual({
      sizeBytes: expectedBytes.byteLength,
      sha256: createHash("sha256").update(expectedBytes).digest("hex"),
      replayed: false,
    });
    await expect(
      fs.readFile(path.join(attemptRoot, "receipt.json")),
    ).resolves.toEqual(expectedBytes);

    const staleLock = path.join(attemptRoot, ".receipt.json.publish.lock");
    await writePrivateFile(staleLock, "interrupted publisher");
    await expect(
      candidate.publishDurableJson(
        "receipt.json",
        { a: { enabled: true }, z: 2 },
        { maximumBytes: 1_024 },
        control,
      ),
    ).resolves.toEqual({ ...first, replayed: true });
    await expect(
      candidate.publishDurableJson(
        "receipt.json",
        { a: { enabled: false }, z: 2 },
        { maximumBytes: 1_024 },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_CONFLICT",
    });

    const cleanup = await candidate.cleanupVolatile(
      [".receipt.json.publish.lock"],
      { maximumBytes: 1_024, maximumEntries: 4, maximumDepth: 2 },
      control,
    );
    expect(cleanup).toEqual({ removedBytes: 21, removedEntries: 1 });

    await fs.link(
      path.join(attemptRoot, "receipt.json"),
      path.join(attemptRoot, "receipt.alias"),
    );
    await expect(
      candidate.publishDurableJson(
        "receipt.json",
        value,
        { maximumBytes: 1_024 },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_COMMIT_AMBIGUOUS",
    });
  });

  it("reconciles publication races without overwrite", async () => {
    const { candidate, trustedRoot, attemptRoot } = await fixture();
    const peer = await openAgentBackupRestoreV3CandidateFs({
      trustedRoot,
      attemptRoot,
      control: operationControl(),
      ...platformTestOption(),
    });
    const options = { maximumBytes: 1_024 } as const;
    const settled = await Promise.allSettled([
      candidate.publishDurableJson(
        "raced.json",
        { exact: "value" },
        options,
        operationControl(),
      ),
      peer.publishDurableJson(
        "raced.json",
        { exact: "value" },
        options,
        operationControl(),
      ),
    ]);
    expect(settled.some((entry) => entry.status === "fulfilled")).toBe(true);
    await expect(
      peer.publishDurableJson(
        "raced.json",
        { exact: "value" },
        options,
        operationControl(),
      ),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      candidate.publishDurableJson(
        "raced.json",
        { exact: "different" },
        options,
        operationControl(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_CONFLICT",
    });
    await peer.close();
  });

  it("repairs the exact link-before-unlink crash state before replay", async () => {
    const { candidate, attemptRoot } = await fixture();
    const name = "linked-commit.json";
    const bytes = Buffer.from('{"committed":true}\n');
    const finalPath = path.join(attemptRoot, name);
    await writePrivateFile(finalPath, bytes);
    const prefix = createHash("sha256").update(name).digest("hex").slice(0, 16);
    const interruptedTemp = path.join(
      attemptRoot,
      `.publish-${prefix}-interrupted.tmp`,
    );
    await fs.link(finalPath, interruptedTemp);
    expect((await fs.lstat(finalPath)).nlink).toBe(2);

    await expect(
      candidate.publishDurableJson(
        name,
        { committed: true },
        { maximumBytes: 1_024 },
        operationControl(),
      ),
    ).resolves.toMatchObject({ replayed: true });
    expect((await fs.lstat(finalPath)).nlink).toBe(1);
    await expect(fs.lstat(interruptedTemp)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects sparse arrays, accessors, extra keys, and symbols", async () => {
    const { candidate } = await fixture();
    const control = operationControl();
    const sparse = new Array(2);
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      configurable: true,
      get: () => "forbidden",
    });
    accessor.length = 1;
    const extra = ["value"] as unknown[] & { extra?: boolean };
    extra.extra = true;
    const symbolic = ["value"];
    Object.defineProperty(symbolic, Symbol("hidden"), { value: true });
    const objectAccessor = {};
    Object.defineProperty(objectAccessor, "value", {
      enumerable: true,
      get: () => "forbidden",
    });
    const values = [sparse, accessor, extra, symbolic, objectAccessor];
    for (const [index, value] of values.entries()) {
      await expect(
        candidate.publishDurableJson(
          `invalid-${index}.json`,
          value,
          { maximumBytes: 1_024 },
          control,
        ),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
      });
    }
  });

  it("makes the tree proof creation-order independent and never accepts links", async () => {
    const { candidate, attemptRoot } = await fixture();
    const control = operationControl();
    await writeProofTree(attemptRoot, "tree-a", false);
    await writeProofTree(attemptRoot, "tree-b", true);
    const limits = {
      maximumBytes: 1_024,
      maximumFiles: 16,
      maximumDirectories: 8,
      maximumDepth: 4,
      maximumPathBytes: 256,
    };
    const first = await candidate.proveTree("tree-a", limits, control);
    const second = await candidate.proveTree("tree-b", limits, control);
    expect(first).toMatchObject({
      sha256: second.sha256,
      bytes: 12,
      files: 3,
      directories: 1,
    });
    expect(first.inode).not.toBe(second.inode);
    await expect(
      candidate.proveTree("../outside", limits, control),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PATH_FORBIDDEN",
    });

    const symlink = path.join(attemptRoot, "tree-a", "escape");
    await fs.symlink(path.join(attemptRoot, "tree-b"), symlink);
    await expect(
      candidate.proveTree("tree-a", limits, control),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_UNSAFE",
    });
    await fs.unlink(symlink);
    const original = path.join(attemptRoot, "tree-a", "a.txt");
    await fs.link(original, path.join(attemptRoot, "tree-a", "a.alias"));
    await expect(
      candidate.proveTree("tree-a", limits, control),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_UNSAFE",
    });
  });

  it("preflights bounded volatile cleanup and refuses links without deleting targets", async () => {
    const { candidate, attemptRoot } = await fixture();
    const control = operationControl();
    const volatileDirectory = path.join(attemptRoot, "volatile-directory");
    const nested = path.join(volatileDirectory, "nested");
    await fs.mkdir(volatileDirectory, { mode: 0o700 });
    await fs.mkdir(nested, { mode: 0o700 });
    await writePrivateFile(path.join(nested, "one.bin"), "one");
    await writePrivateFile(path.join(attemptRoot, "volatile-file"), "two");

    await expect(
      candidate.cleanupVolatile(
        ["volatile-directory", "volatile-file"],
        { maximumBytes: 32, maximumEntries: 1, maximumDepth: 4 },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
    });
    await expect(
      fs.readFile(path.join(nested, "one.bin"), "utf8"),
    ).resolves.toBe("one");

    const outside = path.join(attemptRoot, "outside-cleanup");
    await writePrivateFile(outside, "survivor");
    const unsafe = path.join(attemptRoot, "unsafe-cleanup");
    await fs.symlink(outside, unsafe);
    await expect(
      candidate.cleanupVolatile(
        ["unsafe-cleanup"],
        { maximumBytes: 32, maximumEntries: 4, maximumDepth: 2 },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_UNSAFE",
    });
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("survivor");
    await fs.unlink(unsafe);

    await expect(
      candidate.cleanupVolatile(
        ["volatile-directory", "volatile-file"],
        { maximumBytes: 32, maximumEntries: 8, maximumDepth: 4 },
        control,
      ),
    ).resolves.toEqual({ removedBytes: 6, removedEntries: 4 });
    await expect(fs.lstat(volatileDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.lstat(path.join(attemptRoot, "volatile-file")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed before mutation when operation control is cancelled", async () => {
    const { candidate, attemptRoot } = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    await expect(
      candidate.createPayload(
        "cancelled.payload",
        { maximumBytes: 32, ownerToken: OWNER_TOKEN },
        operationControl(controller.signal),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ABORTED",
    });
    await expect(
      fs.lstat(path.join(attemptRoot, "cancelled.payload")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
