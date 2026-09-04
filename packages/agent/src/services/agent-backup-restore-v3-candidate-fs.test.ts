/**
 * Exercises the restore-v3 candidate filesystem boundary against real private
 * temporary directories, including replay, link attacks, pathname swaps,
 * deterministic proofs, and bounded volatile cleanup.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentBackupRestoreV3CandidateFs,
  AgentBackupRestoreV3CandidateFsLock,
  openAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs.ts";
import {
  lstatExact,
  sameStableFile,
} from "./agent-backup-restore-v3-candidate-fs-control.ts";

const roots = new Set<string>();
const candidates = new Set<AgentBackupRestoreV3CandidateFs>();
const OWNER_TOKEN = "owner-token-for-candidate-fs-tests";

function setLinuxModeForTest(filePath: string, mode: string): void {
  const result = spawnSync("chmod", [mode, filePath], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `chmod ${mode} failed with status ${String(result.status)}: ${result.stderr.trim()}`,
    );
  }
}

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

function payloadCheckpointPaths(
  attemptRoot: string,
  name: string,
): readonly [string, string] {
  const derivation = createHash("sha256").update(name, "utf8").digest("hex");
  const prefix = `.payload-${derivation.slice(0, 32)}.checkpoint-`;
  return [
    path.join(attemptRoot, `${prefix}0.json`),
    path.join(attemptRoot, `${prefix}1.json`),
  ];
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
    expect("detachLock" in candidate).toBe(false);
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

  it("settles lock, writer, and authority teardown exactly once", async () => {
    const { candidate } = await fixture();
    const control = operationControl();
    const lock = await candidate.acquireLock("shared-release.lock", control);
    const firstRelease = lock.release(control);
    const secondRelease = lock.release(control);
    expect(secondRelease).toBe(firstRelease);
    await firstRelease;

    let leaseReleases = 0;
    let detachments = 0;
    const failedLock = new AgentBackupRestoreV3CandidateFsLock({
      owner: {
        detachLock: (_lock: AgentBackupRestoreV3CandidateFsLock) => {
          detachments += 1;
        },
      },
      name: "failed-release.lock",
      lease: {
        release: async () => {
          leaseReleases += 1;
          throw new Error("injected release failure");
        },
      },
    } as never);
    const firstFailure = failedLock.release(control);
    const repeatedFailure = failedLock.release(control);
    expect(repeatedFailure).toBe(firstFailure);
    await expect(firstFailure).rejects.toThrow("injected release failure");
    expect(leaseReleases).toBe(1);
    expect(detachments).toBe(1);

    const writer = await candidate.createPayload(
      "settled.payload",
      { maximumBytes: 32, ownerToken: OWNER_TOKEN },
      control,
    );
    await writer.write(Buffer.from("settled"), control);
    const firstFinalize = writer.finalize(control);
    const secondFinalize = writer.finalize(control);
    expect(secondFinalize).toBe(firstFinalize);
    await firstFinalize;

    const closingWriter = await candidate.createPayload(
      "closed-once.payload",
      { maximumBytes: 32, ownerToken: OWNER_TOKEN },
      control,
    );
    const firstWriterClose = closingWriter.close();
    const secondWriterClose = closingWriter.close();
    expect(secondWriterClose).toBe(firstWriterClose);
    await firstWriterClose;

    const pendingLock = candidate.acquireLock("close-race.lock", control);
    const firstClose = candidate.close();
    const secondClose = candidate.close();
    expect(secondClose).toBe(firstClose);
    await expect(pendingLock).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLOSED",
    });
    await firstClose;
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

  it("does not dispatch secrets through poisoned byte-array and Buffer intrinsics", async () => {
    const { candidate, attemptRoot } = await fixture();
    const control = operationControl();
    const intrinsicReflectApply = Reflect.apply;
    const ownerToken = "owner-token-visible-only-to-candidate-fs";
    const payloadPlaintext = "payload-plaintext-intrinsics";
    const canonicalSecret = "canonical-json-plaintext-intrinsics";
    const treePlaintext = "tree-plaintext-intrinsics";
    const payloadInput = Buffer.from(payloadPlaintext);
    const canonicalValue = { secret: canonicalSecret };
    const publicationName = "intrinsic-publication.json";
    const publicationPrefix = createHash("sha256")
      .update(publicationName)
      .digest("hex")
      .slice(0, 16);
    const treeName = "intrinsic-tree";
    await fs.mkdir(path.join(attemptRoot, treeName), { mode: 0o700 });
    await writePrivateFile(
      path.join(attemptRoot, treeName, "secret.txt"),
      treePlaintext,
    );

    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const uint8ArrayDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "Uint8Array",
    ) as PropertyDescriptor & { value: Uint8ArrayConstructor };
    const byteLengthDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "byteLength",
    ) as PropertyDescriptor & { get: () => number };
    const bufferDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "buffer",
    ) as PropertyDescriptor & { get: () => ArrayBufferLike };
    const byteOffsetDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "byteOffset",
    ) as PropertyDescriptor & { get: () => number };
    const fillDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "fill",
    ) as PropertyDescriptor & { value: Uint8Array["fill"] };
    const subarrayDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "subarray",
    ) as PropertyDescriptor & { value: Uint8Array["subarray"] };
    const equalsDescriptor = Object.getOwnPropertyDescriptor(
      Buffer.prototype,
      "equals",
    ) as PropertyDescriptor & { value: Buffer["equals"] };
    const toStringDescriptor = Object.getOwnPropertyDescriptor(
      Buffer.prototype,
      "toString",
    ) as PropertyDescriptor & { value: Buffer["toString"] };
    const fromDescriptor = Object.getOwnPropertyDescriptor(
      Buffer,
      "from",
    ) as PropertyDescriptor & { value: typeof Buffer.from };
    const bufferByteLengthDescriptor = Object.getOwnPropertyDescriptor(
      Buffer,
      "byteLength",
    ) as PropertyDescriptor & { value: typeof Buffer.byteLength };
    const reflectApplyDescriptor = Object.getOwnPropertyDescriptor(
      Reflect,
      "apply",
    ) as PropertyDescriptor & { value: typeof Reflect.apply };
    const definePropertiesDescriptor = Object.getOwnPropertyDescriptor(
      Object,
      "defineProperties",
    ) as PropertyDescriptor & { value: typeof Object.defineProperties };
    const getOwnPropertyDescriptorDescriptor = Object.getOwnPropertyDescriptor(
      Object,
      "getOwnPropertyDescriptor",
    ) as PropertyDescriptor & { value: typeof Object.getOwnPropertyDescriptor };
    const getOwnPropertyDescriptorsDescriptor = Object.getOwnPropertyDescriptor(
      Object,
      "getOwnPropertyDescriptors",
    ) as PropertyDescriptor & {
      value: typeof Object.getOwnPropertyDescriptors;
    };
    const getPrototypeOfDescriptor = Object.getOwnPropertyDescriptor(
      Object,
      "getPrototypeOf",
    ) as PropertyDescriptor & { value: typeof Object.getPrototypeOf };
    const freezeDescriptor = Object.getOwnPropertyDescriptor(
      Object,
      "freeze",
    ) as PropertyDescriptor & { value: typeof Object.freeze };
    const reflectOwnKeysDescriptor = Object.getOwnPropertyDescriptor(
      Reflect,
      "ownKeys",
    ) as PropertyDescriptor & { value: typeof Reflect.ownKeys };
    const stringIncludesDescriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      "includes",
    ) as PropertyDescriptor & { value: typeof String.prototype.includes };
    const stringStartsWithDescriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      "startsWith",
    ) as PropertyDescriptor & { value: typeof String.prototype.startsWith };
    const stringSplitDescriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      "split",
    ) as PropertyDescriptor & { value: typeof String.prototype.split };
    const stringTrimDescriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      "trim",
    ) as PropertyDescriptor & { value: typeof String.prototype.trim };
    const arrayJoinDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "join",
    ) as PropertyDescriptor & { value: typeof Array.prototype.join };
    const arraySomeDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "some",
    ) as PropertyDescriptor & { value: typeof Array.prototype.some };
    const arraySortDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "sort",
    ) as PropertyDescriptor & { value: typeof Array.prototype.sort };

    const probe = await fs.open(
      path.join(attemptRoot, "intrinsic-write-probe"),
      "w+",
      0o600,
    );
    const handlePrototype = Object.getPrototypeOf(probe) as object;
    const writeDescriptor = Object.getOwnPropertyDescriptor(
      handlePrototype,
      "write",
    ) as PropertyDescriptor & {
      value: (
        this: unknown,
        buffer: Uint8Array,
        offset?: number,
        length?: number,
        position?: number | null,
      ) => Promise<unknown>;
    };
    const readDescriptor = Object.getOwnPropertyDescriptor(
      handlePrototype,
      "read",
    ) as PropertyDescriptor & {
      value: (
        this: unknown,
        buffer: Uint8Array,
        offset?: number,
        length?: number,
        position?: number | null,
      ) => Promise<unknown>;
    };
    const closeDescriptor = Object.getOwnPropertyDescriptor(
      handlePrototype,
      "close",
    ) as PropertyDescriptor & {
      value: (this: unknown) => Promise<unknown>;
    };
    await probe.close();
    await fs.unlink(path.join(attemptRoot, "intrinsic-write-probe"));

    const traps: string[] = [];
    const payloadBuffers = new Set<Uint8Array>();
    const canonicalBuffers = new Set<Uint8Array>();
    const treeBuffers = new Set<Uint8Array>();
    const failedCanonicalReadBuffers = new Set<Uint8Array>();
    const failedCanonicalCloseBuffers = new Set<Uint8Array>();
    let forceCanonicalReadFailure = false;
    let forcedCanonicalReadFailureSeen = false;
    let forceCanonicalCloseFailure = false;
    let forcedCanonicalCloseFailureSeen = false;
    let unsafeRelativePathRejected = false;
    let canonicalCloseTarget: unknown = null;
    const byteArrayIncludes = (
      value: Uint8Array,
      expected: string,
    ): boolean => {
      const length = intrinsicReflectApply(byteLengthDescriptor.get, value, []);
      if (expected.length > length) return false;
      outer: for (
        let start = 0;
        start <= length - expected.length;
        start += 1
      ) {
        for (let index = 0; index < expected.length; index += 1) {
          if (value[start + index] !== expected.charCodeAt(index))
            continue outer;
        }
        return true;
      }
      return false;
    };
    const allZero = (value: Uint8Array): boolean => {
      const length = intrinsicReflectApply(byteLengthDescriptor.get, value, []);
      for (let index = 0; index < length; index += 1) {
        if (value[index] !== 0) return false;
      }
      return true;
    };

    Object.defineProperty(handlePrototype, "write", {
      ...writeDescriptor,
      value: async function (
        this: unknown,
        buffer: Uint8Array,
        offset?: number,
        length?: number,
        position?: number | null,
      ): Promise<unknown> {
        if (byteArrayIncludes(buffer, payloadPlaintext)) {
          payloadBuffers.add(buffer);
        }
        if (byteArrayIncludes(buffer, canonicalSecret)) {
          canonicalBuffers.add(buffer);
        }
        return intrinsicReflectApply(writeDescriptor.value, this, [
          buffer,
          offset,
          length,
          position,
        ]);
      },
    });
    Object.defineProperty(handlePrototype, "read", {
      ...readDescriptor,
      value: async function (
        this: unknown,
        buffer: Uint8Array,
        offset?: number,
        length?: number,
        position?: number | null,
      ): Promise<unknown> {
        const result = await intrinsicReflectApply(readDescriptor.value, this, [
          buffer,
          offset,
          length,
          position,
        ]);
        if (byteArrayIncludes(buffer, treePlaintext)) {
          treeBuffers.add(buffer);
        }
        if (
          forceCanonicalReadFailure &&
          byteArrayIncludes(buffer, canonicalSecret)
        ) {
          forceCanonicalReadFailure = false;
          failedCanonicalReadBuffers.add(buffer);
          throw new Error("forced canonical read failure after fill");
        }
        if (
          forceCanonicalCloseFailure &&
          byteArrayIncludes(buffer, canonicalSecret)
        ) {
          canonicalCloseTarget = this;
          failedCanonicalCloseBuffers.add(buffer);
        }
        return result;
      },
    });
    Object.defineProperty(handlePrototype, "close", {
      ...closeDescriptor,
      value: async function (this: unknown): Promise<unknown> {
        const result = await intrinsicReflectApply(
          closeDescriptor.value,
          this,
          [],
        );
        if (this === canonicalCloseTarget) {
          canonicalCloseTarget = null;
          forceCanonicalCloseFailure = false;
          throw new Error("forced canonical close failure after fill");
        }
        return result;
      },
    });

    const restorations: Array<
      readonly [object, PropertyKey, PropertyDescriptor]
    > = [
      [typedArrayPrototype, "byteLength", byteLengthDescriptor],
      [typedArrayPrototype, "buffer", bufferDescriptor],
      [typedArrayPrototype, "byteOffset", byteOffsetDescriptor],
      [typedArrayPrototype, "fill", fillDescriptor],
      [typedArrayPrototype, "subarray", subarrayDescriptor],
      [Buffer.prototype, "equals", equalsDescriptor],
      [Buffer.prototype, "toString", toStringDescriptor],
      [Buffer, "from", fromDescriptor],
      [Buffer, "byteLength", bufferByteLengthDescriptor],
      [globalThis, "Uint8Array", uint8ArrayDescriptor],
      [Reflect, "apply", reflectApplyDescriptor],
      [Object, "defineProperties", definePropertiesDescriptor],
      [Object, "getOwnPropertyDescriptor", getOwnPropertyDescriptorDescriptor],
      [
        Object,
        "getOwnPropertyDescriptors",
        getOwnPropertyDescriptorsDescriptor,
      ],
      [Object, "getPrototypeOf", getPrototypeOfDescriptor],
      [Object, "freeze", freezeDescriptor],
      [Reflect, "ownKeys", reflectOwnKeysDescriptor],
      [String.prototype, "includes", stringIncludesDescriptor],
      [String.prototype, "startsWith", stringStartsWithDescriptor],
      [String.prototype, "split", stringSplitDescriptor],
      [String.prototype, "trim", stringTrimDescriptor],
      [Array.prototype, "join", arrayJoinDescriptor],
      [Array.prototype, "some", arraySomeDescriptor],
      [Array.prototype, "sort", arraySortDescriptor],
    ];
    const poisonGetter = (
      target: object,
      key: PropertyKey,
      descriptor: PropertyDescriptor & { get: () => unknown },
      trap: string,
      shouldTrap: (receiver: unknown) => boolean = () => true,
    ) => {
      Object.defineProperty(target, key, {
        ...descriptor,
        get: function (this: unknown) {
          if (shouldTrap(this)) traps.push(trap);
          return intrinsicReflectApply(descriptor.get, this, []);
        },
      });
    };
    const poisonMethod = (
      target: object,
      key: PropertyKey,
      descriptor: PropertyDescriptor & { value: (...args: never[]) => unknown },
      trap: string,
    ) => {
      Object.defineProperty(target, key, {
        ...descriptor,
        value: function (this: unknown, ...args: never[]) {
          traps.push(trap);
          return intrinsicReflectApply(descriptor.value, this, args);
        },
      });
    };
    const containsSensitiveBytes = (value: unknown): boolean => {
      try {
        return (
          byteArrayIncludes(value as Uint8Array, payloadPlaintext) ||
          byteArrayIncludes(value as Uint8Array, canonicalSecret) ||
          byteArrayIncludes(value as Uint8Array, treePlaintext)
        );
      } catch {
        return false;
      }
    };

    try {
      Object.defineProperty(globalThis, "Uint8Array", {
        ...uint8ArrayDescriptor,
        value: new Proxy(uint8ArrayDescriptor.value, {
          construct(target, argumentsList) {
            traps.push("Uint8Array constructor");
            return Reflect.construct(target, argumentsList, target);
          },
        }),
      });
      poisonGetter(
        typedArrayPrototype,
        "byteLength",
        byteLengthDescriptor,
        "TypedArray.byteLength",
        containsSensitiveBytes,
      );
      poisonGetter(
        typedArrayPrototype,
        "buffer",
        bufferDescriptor,
        "TypedArray.buffer",
        containsSensitiveBytes,
      );
      poisonGetter(
        typedArrayPrototype,
        "byteOffset",
        byteOffsetDescriptor,
        "TypedArray.byteOffset",
        containsSensitiveBytes,
      );
      poisonMethod(
        typedArrayPrototype,
        "fill",
        fillDescriptor,
        "TypedArray.fill",
      );
      poisonMethod(
        typedArrayPrototype,
        "subarray",
        subarrayDescriptor,
        "TypedArray.subarray",
      );
      poisonMethod(
        Buffer.prototype,
        "equals",
        equalsDescriptor,
        "Buffer.equals",
      );
      poisonMethod(
        Buffer.prototype,
        "toString",
        toStringDescriptor,
        "Buffer.toString",
      );
      poisonMethod(Buffer, "from", fromDescriptor, "Buffer.from");
      poisonMethod(
        Buffer,
        "byteLength",
        bufferByteLengthDescriptor,
        "Buffer.byteLength",
      );
      poisonMethod(Reflect, "apply", reflectApplyDescriptor, "Reflect.apply");
      poisonMethod(
        Object,
        "defineProperties",
        definePropertiesDescriptor,
        "Object.defineProperties",
      );
      poisonMethod(
        Object,
        "getOwnPropertyDescriptor",
        getOwnPropertyDescriptorDescriptor,
        "Object.getOwnPropertyDescriptor",
      );
      poisonMethod(
        Object,
        "getOwnPropertyDescriptors",
        getOwnPropertyDescriptorsDescriptor,
        "Object.getOwnPropertyDescriptors",
      );
      poisonMethod(
        Object,
        "getPrototypeOf",
        getPrototypeOfDescriptor,
        "Object.getPrototypeOf",
      );
      poisonMethod(Object, "freeze", freezeDescriptor, "Object.freeze");
      poisonMethod(
        Reflect,
        "ownKeys",
        reflectOwnKeysDescriptor,
        "Reflect.ownKeys",
      );
      poisonMethod(
        String.prototype,
        "includes",
        stringIncludesDescriptor,
        "String.includes",
      );
      poisonMethod(
        String.prototype,
        "startsWith",
        stringStartsWithDescriptor,
        "String.startsWith",
      );
      poisonMethod(
        String.prototype,
        "split",
        stringSplitDescriptor,
        "String.split",
      );
      poisonMethod(
        String.prototype,
        "trim",
        stringTrimDescriptor,
        "String.trim",
      );
      poisonMethod(Array.prototype, "join", arrayJoinDescriptor, "Array.join");
      poisonMethod(Array.prototype, "some", arraySomeDescriptor, "Array.some");
      poisonMethod(Array.prototype, "sort", arraySortDescriptor, "Array.sort");

      try {
        await candidate.createPayload(
          "../../../../tmp/escape.payload",
          { maximumBytes: 128, ownerToken },
          control,
        );
      } catch (cause) {
        unsafeRelativePathRejected =
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PATH_FORBIDDEN";
      }

      const writer = await candidate.createPayload(
        "intrinsic.payload",
        { maximumBytes: 128, ownerToken },
        control,
      );
      await writer.write(payloadInput, control);
      await writer.finalize(control);

      await candidate.publishDurableJson(
        publicationName,
        canonicalValue,
        { maximumBytes: 1_024 },
        control,
      );
      forceCanonicalReadFailure = true;
      try {
        await candidate.publishDurableJson(
          publicationName,
          canonicalValue,
          { maximumBytes: 1_024 },
          control,
        );
      } catch (cause) {
        forcedCanonicalReadFailureSeen =
          cause instanceof Error &&
          cause.message === "forced canonical read failure after fill";
      } finally {
        forceCanonicalReadFailure = false;
      }
      forceCanonicalCloseFailure = true;
      try {
        await candidate.publishDurableJson(
          publicationName,
          canonicalValue,
          { maximumBytes: 1_024 },
          control,
        );
      } catch (cause) {
        forcedCanonicalCloseFailureSeen =
          cause instanceof Error &&
          cause.message === "forced canonical close failure after fill";
      } finally {
        forceCanonicalCloseFailure = false;
        canonicalCloseTarget = null;
      }
      const publicationPath = path.join(attemptRoot, publicationName);
      const interruptedTemp = path.join(
        attemptRoot,
        `.publish-${publicationPrefix}-intrinsic.tmp`,
      );
      await fs.link(publicationPath, interruptedTemp);
      await candidate.publishDurableJson(
        publicationName,
        canonicalValue,
        { maximumBytes: 1_024 },
        control,
      );
      await candidate.proveTree(
        treeName,
        {
          maximumBytes: 1_024,
          maximumFiles: 4,
          maximumDirectories: 2,
          maximumDepth: 2,
          maximumPathBytes: 128,
        },
        control,
      );
    } finally {
      for (const [target, key, descriptor] of restorations.reverse()) {
        Object.defineProperty(target, key, descriptor);
      }
      Object.defineProperty(handlePrototype, "write", writeDescriptor);
      Object.defineProperty(handlePrototype, "read", readDescriptor);
      Object.defineProperty(handlePrototype, "close", closeDescriptor);
    }

    expect(traps).toEqual([]);
    expect(payloadInput.toString("utf8")).toBe(payloadPlaintext);
    expect(payloadBuffers.size).toBeGreaterThan(0);
    expect(canonicalBuffers.size).toBeGreaterThan(0);
    expect(treeBuffers.size).toBeGreaterThan(0);
    expect(forcedCanonicalReadFailureSeen).toBe(true);
    expect(failedCanonicalReadBuffers.size).toBeGreaterThan(0);
    expect(forcedCanonicalCloseFailureSeen).toBe(true);
    expect(unsafeRelativePathRejected).toBe(true);
    expect(failedCanonicalCloseBuffers.size).toBeGreaterThan(0);
    expect([...payloadBuffers]).not.toContain(payloadInput);
    expect([...payloadBuffers].every(allZero)).toBe(true);
    expect([...canonicalBuffers].every(allZero)).toBe(true);
    expect([...treeBuffers].every(allZero)).toBe(true);
    expect([...failedCanonicalReadBuffers].every(allZero)).toBe(true);
    expect([...failedCanonicalCloseBuffers].every(allZero)).toBe(true);
    await expect(
      fs.readFile(path.join(attemptRoot, "intrinsic.payload"), "utf8"),
    ).resolves.toBe(payloadPlaintext);
    await expect(
      fs.readFile(path.join(attemptRoot, publicationName), "utf8"),
    ).resolves.toBe(`{"secret":"${canonicalSecret}"}\n`);
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

    const iteratorOverride = await candidate.createPayload(
      "iterator-override.payload",
      { maximumBytes: 1, ownerToken: OWNER_TOKEN },
      control,
    );
    const oneByteFragment = Uint8Array.of(0x61);
    Object.defineProperty(oneByteFragment, Symbol.iterator, {
      value: function* () {
        yield 0x61;
        yield 0x62;
        yield 0x63;
      },
    });
    await iteratorOverride.write(oneByteFragment, control);
    await expect(iteratorOverride.finalize(control)).resolves.toMatchObject({
      sizeBytes: 1,
      sha256: createHash("sha256").update("a").digest("hex"),
    });

    const proxyWriter = await candidate.createPayload(
      "proxy-fragment.payload",
      { maximumBytes: 1, ownerToken: OWNER_TOKEN },
      control,
    );
    let reentrantWrite: Promise<void> | null = null;
    const proxyFragment = new Proxy(Uint8Array.of(0x61), {
      getPrototypeOf: () => {
        reentrantWrite = proxyWriter.write(Uint8Array.of(0x62), control);
        return Uint8Array.prototype;
      },
    });
    expect(() => proxyWriter.write(proxyFragment, control)).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FRAGMENT_INVALID",
      }),
    );
    expect(reentrantWrite).toBeNull();
    expect(() =>
      proxyWriter.write(new Uint16Array([0x1234]) as never, control),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FRAGMENT_INVALID",
      }),
    );
    await proxyWriter.close();

    if (typeof SharedArrayBuffer !== "undefined") {
      const sharedWriter = await candidate.createPayload(
        "shared-memory.payload",
        { maximumBytes: 1, ownerToken: OWNER_TOKEN },
        control,
      );
      const shared = new Uint8Array(new SharedArrayBuffer(1));
      expect(() => sharedWriter.write(shared, control)).toThrowError(
        expect.objectContaining({
          code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FRAGMENT_INVALID",
        }),
      );
      await sharedWriter.close();
    }

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

    const checkpointPaths = payloadCheckpointPaths(
      attemptRoot,
      "recoverable.payload",
    );
    const initialCheckpoints = await Promise.all(
      checkpointPaths.map(async (checkpointPath) =>
        JSON.parse(await fs.readFile(checkpointPath, "utf8")),
      ),
    );
    expect(
      initialCheckpoints
        .map((checkpoint) => checkpoint.generation as number)
        .sort((left, right) => left - right),
    ).toEqual([0, 1]);

    // Crash after deleting the stale target slot and extending the payload,
    // but before publishing the next durable checkpoint.
    await fs.unlink(checkpointPaths[0]);
    await fs.appendFile(
      path.join(attemptRoot, "recoverable.payload"),
      "uncheckpointed",
    );

    const resumed = await candidate.createPayload(
      "recoverable.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    expect(resumed.acknowledgedBytes).toBe(3);
    await expect(
      fs.readFile(path.join(attemptRoot, "recoverable.payload"), "utf8"),
    ).resolves.toBe("abc");
    await resumed.write(Buffer.from("def"), control);
    await resumed.close();

    const committedCheckpoints = await Promise.all(
      checkpointPaths.map(async (checkpointPath) =>
        JSON.parse(await fs.readFile(checkpointPath, "utf8")),
      ),
    );
    expect(
      committedCheckpoints
        .map((checkpoint) => checkpoint.generation as number)
        .sort((left, right) => left - right),
    ).toEqual([1, 2]);

    // Lost response after the checkpoint commit must recover the new offset.
    const afterLostWrite = await candidate.createPayload(
      "recoverable.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    expect(afterLostWrite.acknowledgedBytes).toBe(6);
    const receipt = await afterLostWrite.finalize(control);

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

  it("fails closed when a durable payload checkpoint is ahead or has the wrong prefix hash", async () => {
    const { candidate, attemptRoot } = await fixture();
    const control = operationControl();

    const shorter = await candidate.createPayload(
      "shorter-than-checkpoint.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    await shorter.write(Buffer.from("abc"), control);
    await shorter.close();
    await fs.truncate(
      path.join(attemptRoot, "shorter-than-checkpoint.payload"),
      2,
    );
    await expect(
      candidate.createPayload(
        "shorter-than-checkpoint.payload",
        { maximumBytes: 64, ownerToken: OWNER_TOKEN },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
    });

    const corrupted = await candidate.createPayload(
      "corrupt-checkpoint-prefix.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    await corrupted.write(Buffer.from("abc"), control);
    await corrupted.close();
    await fs.writeFile(
      path.join(attemptRoot, "corrupt-checkpoint-prefix.payload"),
      "xbc",
    );
    await expect(
      candidate.createPayload(
        "corrupt-checkpoint-prefix.payload",
        { maximumBytes: 64, ownerToken: OWNER_TOKEN },
        control,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
    });
  });

  it("keeps the inode lock until uncheckpointed suffix rollback settles", async () => {
    const { candidate, trustedRoot, attemptRoot } = await fixture();
    const control = operationControl();
    const writer = await candidate.createPayload(
      "checkpoint-lock.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    await writer.write(Buffer.from("abc"), control);
    await writer.close();
    const payloadPath = path.join(attemptRoot, "checkpoint-lock.payload");
    await fs.appendFile(payloadPath, "uncheckpointed");

    const peer = await openAgentBackupRestoreV3CandidateFs({
      trustedRoot,
      attemptRoot,
      control,
      ...platformTestOption(),
    });
    candidates.add(peer);

    const probe = await fs.open(payloadPath, "r+");
    type TruncatableHandle = {
      truncate(length?: number): Promise<void>;
    };
    const handlePrototype = Object.getPrototypeOf(probe) as TruncatableHandle;
    const originalTruncate = handlePrototype.truncate;
    await probe.close();
    let releaseTruncate: () => void = () => undefined;
    let enteredTruncate: () => void = () => undefined;
    const truncateEntered = new Promise<void>((resolve) => {
      enteredTruncate = resolve;
    });
    const truncateGate = new Promise<void>((resolve) => {
      releaseTruncate = resolve;
    });
    let intercepted = false;
    const truncate = vi
      .spyOn(handlePrototype, "truncate")
      .mockImplementation(async function (
        this: TruncatableHandle,
        length?: number,
      ) {
        if (!intercepted && length === 3) {
          intercepted = true;
          enteredTruncate();
          await truncateGate;
        }
        return Reflect.apply(originalTruncate, this, [length]);
      });
    let recovered:
      | Awaited<ReturnType<AgentBackupRestoreV3CandidateFs["createPayload"]>>
      | undefined;
    try {
      const pendingRecovery = candidate.createPayload(
        "checkpoint-lock.payload",
        { maximumBytes: 64, ownerToken: OWNER_TOKEN },
        control,
      );
      await truncateEntered;
      await expect(
        peer.acquireLock("rollback-race.lock", control),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_BUSY",
      });
      releaseTruncate();
      recovered = await pendingRecovery;
      expect(recovered.acknowledgedBytes).toBe(3);
    } finally {
      releaseTruncate();
      truncate.mockRestore();
      await recovered?.close();
    }
  });

  it("revalidates the acknowledged prefix after crash-suffix truncation", async () => {
    const { candidate, attemptRoot } = await fixture();
    const control = operationControl();
    const writer = await candidate.createPayload(
      "checkpoint-truncate-race.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    await writer.write(Buffer.from("abc"), control);
    await writer.close();
    const payloadPath = path.join(
      attemptRoot,
      "checkpoint-truncate-race.payload",
    );
    await fs.appendFile(payloadPath, "uncheckpointed");

    const probe = await fs.open(payloadPath, "r+");
    type TruncatableHandle = {
      truncate(length?: number): Promise<void>;
    };
    const handlePrototype = Object.getPrototypeOf(probe) as TruncatableHandle;
    const originalTruncate = handlePrototype.truncate;
    await probe.close();
    let intercepted = false;
    const truncate = vi
      .spyOn(handlePrototype, "truncate")
      .mockImplementation(async function (
        this: TruncatableHandle,
        length?: number,
      ) {
        if (!intercepted && length === 3) {
          intercepted = true;
          // Simulate a same-inode attacker rewriting already acknowledged
          // bytes after the pre-truncate hash but before ftruncate settles.
          await fs.writeFile(payloadPath, "xbcuncheckpointed");
        }
        return Reflect.apply(originalTruncate, this, [length]);
      });
    try {
      await expect(
        candidate.createPayload(
          "checkpoint-truncate-race.payload",
          { maximumBytes: 64, ownerToken: OWNER_TOKEN },
          control,
        ),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
      });
      expect(intercepted).toBe(true);
      await expect(fs.readFile(payloadPath, "utf8")).resolves.toBe("xbc");
    } finally {
      truncate.mockRestore();
    }
  });

  it("reconciles checkpoint publication before deciding whether to roll back", async () => {
    const { candidate, attemptRoot } = await fixture();
    const control = operationControl();

    const committedWriter = await candidate.createPayload(
      "checkpoint-linked.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    const committedController = new AbortController();
    const originalLink = fs.link.bind(fs);
    const linkedCheckpoint = vi
      .spyOn(fs, "link")
      .mockImplementation(async (source, destination) => {
        await originalLink(source, destination);
        if (String(destination).endsWith(".checkpoint-1.json")) {
          committedController.abort(
            new Error("lost response after checkpoint link"),
          );
        }
      });
    try {
      await expect(
        committedWriter.write(
          Buffer.from("abc"),
          operationControl(committedController.signal),
        ),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ABORTED",
      });
    } finally {
      linkedCheckpoint.mockRestore();
    }
    const recoveredCommit = await candidate.createPayload(
      "checkpoint-linked.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    expect(recoveredCommit.acknowledgedBytes).toBe(3);
    await expect(
      fs.readFile(path.join(attemptRoot, "checkpoint-linked.payload"), "utf8"),
    ).resolves.toBe("abc");
    await recoveredCommit.close();

    const uncommittedWriter = await candidate.createPayload(
      "checkpoint-not-linked.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    const failedCheckpoint = vi
      .spyOn(fs, "link")
      .mockImplementation(async (_source, destination) => {
        if (String(destination).endsWith(".checkpoint-1.json")) {
          throw new Error("injected checkpoint link failure");
        }
        throw new Error("unexpected link target");
      });
    try {
      await expect(
        uncommittedWriter.write(Buffer.from("abc"), control),
      ).rejects.toThrow("injected checkpoint link failure");
    } finally {
      failedCheckpoint.mockRestore();
    }
    const recoveredRollback = await candidate.createPayload(
      "checkpoint-not-linked.payload",
      { maximumBytes: 64, ownerToken: OWNER_TOKEN },
      control,
    );
    expect(recoveredRollback.acknowledgedBytes).toBe(0);
    await expect(
      fs.stat(path.join(attemptRoot, "checkpoint-not-linked.payload")),
    ).resolves.toMatchObject({ size: 0 });
    await recoveredRollback.close();
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
    expect(recovered.acknowledgedBytes).toBe(0);
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

  it("does not scan the attempt directory for a new durable publication", async () => {
    const { candidate } = await fixture();
    const openDirectory = vi.spyOn(fs, "opendir");
    try {
      await expect(
        candidate.publishDurableJson(
          "fresh-publication.json",
          { exact: true },
          { maximumBytes: 1_024 },
          operationControl(),
        ),
      ).resolves.toMatchObject({ replayed: false });
      expect(openDirectory).not.toHaveBeenCalled();
    } finally {
      openDirectory.mockRestore();
    }
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

  it("snapshots caller-owned contracts and rejects accessors and proxies", async () => {
    const trustedRoot = await privateTemporaryRoot(
      "restore-v3-candidate-input-snapshot-",
    );
    const attemptRoot = path.join(trustedRoot, "attempt");
    const replacementRoot = path.join(trustedRoot, "replacement");
    await fs.mkdir(attemptRoot, { mode: 0o700 });
    await fs.mkdir(replacementRoot, { mode: 0o700 });
    const openInput = {
      trustedRoot,
      attemptRoot,
      control: operationControl(),
      ...platformTestOption(),
    };
    const pendingOpen = openAgentBackupRestoreV3CandidateFs(openInput);
    openInput.attemptRoot = replacementRoot;
    const candidate = await pendingOpen;
    candidates.add(candidate);
    expect(candidate.attemptRoot).toBe(attemptRoot);

    let accessorRead = false;
    const accessorInput = {
      trustedRoot,
      control: operationControl(),
      ...platformTestOption(),
    } as Record<string, unknown>;
    Object.defineProperty(accessorInput, "attemptRoot", {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return replacementRoot;
      },
    });
    await expect(
      openAgentBackupRestoreV3CandidateFs(accessorInput as never),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_ROOT_INVALID",
    });
    expect(accessorRead).toBe(false);

    const accessorControl = {
      signal: new AbortController().signal,
    } as Record<string, unknown>;
    Object.defineProperty(accessorControl, "deadlineEpochMs", {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return Date.now() + 30_000;
      },
    });
    await expect(
      candidate.publishDurableJson(
        "accessor-control.json",
        { exact: true },
        { maximumBytes: 256 },
        accessorControl as never,
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CONTROL_INVALID",
    });
    expect(accessorRead).toBe(false);

    const accessorOptions = { ownerToken: OWNER_TOKEN } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorOptions, "maximumBytes", {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return 32;
      },
    });
    await expect(
      candidate.createPayload(
        "accessor-options.payload",
        accessorOptions as never,
        operationControl(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LIMIT_INVALID",
    });
    expect(accessorRead).toBe(false);

    const receiptWithAccessor = {
      sha256: "0".repeat(64),
      device: "1",
      inode: "1",
    } as Record<string, unknown>;
    Object.defineProperty(receiptWithAccessor, "sizeBytes", {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return 0;
      },
    });
    await expect(
      candidate.provePayload(
        "accessor-receipt.payload",
        receiptWithAccessor as never,
        { maximumBytes: 32 },
        operationControl(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
    });
    expect(accessorRead).toBe(false);

    let proxyTrapCalled = false;
    const nestedProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          proxyTrapCalled = true;
          return Object.prototype;
        },
      },
    );
    await expect(
      candidate.publishDurableJson(
        "proxy-value.json",
        { nested: nestedProxy },
        { maximumBytes: 256 },
        operationControl(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
    });
    expect(proxyTrapCalled).toBe(false);

    const cleanupProxy = new Proxy(["survivor"], {
      getOwnPropertyDescriptor: () => {
        proxyTrapCalled = true;
        return undefined;
      },
    });
    await expect(
      candidate.cleanupVolatile(
        cleanupProxy,
        { maximumBytes: 32, maximumEntries: 2, maximumDepth: 1 },
        operationControl(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
    });
    expect(proxyTrapCalled).toBe(false);

    const revokedOptions = Proxy.revocable(
      { maximumBytes: 32, ownerToken: OWNER_TOKEN },
      {},
    );
    revokedOptions.revoke();
    await expect(
      candidate.createPayload(
        "revoked-options.payload",
        revokedOptions.proxy,
        operationControl(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LIMIT_INVALID",
    });

    const revokedNames = Proxy.revocable(["survivor"], {});
    revokedNames.revoke();
    await expect(
      candidate.cleanupVolatile(
        revokedNames.proxy,
        { maximumBytes: 32, maximumEntries: 2, maximumDepth: 1 },
        operationControl(),
      ),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
    });

    const mutableOptions = {
      maximumBytes: 1,
      ownerToken: OWNER_TOKEN,
    };
    const pendingWriter = candidate.createPayload(
      "snapshotted-options.payload",
      mutableOptions,
      operationControl(),
    );
    mutableOptions.maximumBytes = 64;
    const boundedWriter = await pendingWriter;
    expect(() =>
      boundedWriter.write(Buffer.from("too large"), operationControl()),
    ).toThrowError(
      expect.objectContaining({
        code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_LIMIT",
      }),
    );
    await boundedWriter.close();
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
    if (process.platform === "linux") {
      const privilegedFile = path.join(attemptRoot, "tree-a", "a.txt");
      // Bun 1.3.14 masks special bits in fs.chmod on Linux, so exercise the
      // kernel modes through the system utility and assert the precondition.
      try {
        for (const [mode, specialBits] of [
          ["4600", 0o4000],
          ["2600", 0o2000],
          ["1600", 0o1000],
        ] as const) {
          setLinuxModeForTest(privilegedFile, mode);
          expect((await lstatExact(privilegedFile)).mode & 0o7000).toBe(
            specialBits,
          );
          await expect(
            candidate.proveTree("tree-a", limits, control),
          ).rejects.toMatchObject({
            code: "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_UNSAFE",
          });
        }
      } finally {
        setLinuxModeForTest(privilegedFile, "600");
      }
    }
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

  it("detects same-inode rewrites even when size, mode, and mtime match", async () => {
    const { attemptRoot } = await fixture();
    const file = path.join(attemptRoot, "ctime-bound.bin");
    await writePrivateFile(file, "first");
    const fixedTime = new Date(Math.floor(Date.now() / 1_000 - 10) * 1_000);
    await fs.utimes(file, fixedTime, fixedTime);
    const before = await lstatExact(file);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(file, "other");
    await fs.utimes(file, fixedTime, fixedTime);
    const after = await lstatExact(file);
    expect(after.inode).toBe(before.inode);
    expect(after.size).toBe(before.size);
    expect(after.mode).toBe(before.mode);
    expect(after.modifiedNanoseconds).toBe(before.modifiedNanoseconds);
    expect(after.changedNanoseconds).not.toBe(before.changedNanoseconds);
    expect(sameStableFile(before, after)).toBe(false);
  });

  it("rejects raw invalid UTF-8 directory entries on Linux", async () => {
    if (process.platform !== "linux") return;
    const { candidate, attemptRoot } = await fixture();
    const treeRoot = path.join(attemptRoot, "raw-name-tree");
    await fs.mkdir(treeRoot, { mode: 0o700 });
    const invalidName = Buffer.concat([
      Buffer.from(`${treeRoot}${path.sep}`),
      Buffer.from([0xff]),
    ]);
    await fs.writeFile(invalidName, "invalid", { flag: "wx", mode: 0o600 });
    await writePrivateFile(path.join(treeRoot, "�"), "valid");
    await expect(
      candidate.proveTree(
        "raw-name-tree",
        {
          maximumBytes: 64,
          maximumFiles: 4,
          maximumDirectories: 2,
          maximumDepth: 2,
          maximumPathBytes: 64,
        },
        operationControl(),
      ),
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

    const lateName: string[] = [];
    const lateCleanup = candidate.cleanupVolatile(
      lateName,
      { maximumBytes: 32, maximumEntries: 4, maximumDepth: 2 },
      control,
    );
    lateName.push("outside-cleanup");
    await expect(lateCleanup).resolves.toEqual({
      removedBytes: 0,
      removedEntries: 0,
    });
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("survivor");

    const iteratorNames: string[] = [];
    Object.defineProperty(iteratorNames, Symbol.iterator, {
      value: function* () {
        yield "outside-cleanup";
      },
    });
    await expect(
      candidate.cleanupVolatile(
        iteratorNames,
        { maximumBytes: 32, maximumEntries: 4, maximumDepth: 2 },
        control,
      ),
    ).resolves.toEqual({ removedBytes: 0, removedEntries: 0 });
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("survivor");

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
