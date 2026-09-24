import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { InstallRecoveryRequiredError } from "./executor";
import type {
  InstallAuthorizationReplayStore,
  InstallTargetSerializer,
} from "./root-service";
import type { InstallAuthorization } from "./types";

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_AUTHORIZATION_RECORDS = 4096;
const MAX_AUTHORIZATION_ID_BYTES = 256;
const MAX_TIMESTAMP_BYTES = 64;
const MAX_KERNEL_IDENTITY_BYTES = 256;

export interface DurableFileInstallServiceStateOptions {
  /** Hard fail-closed cap. Consumed authorizations are never automatically deleted. */
  maxAuthorizationRecords?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function operatingUid(): number {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new InstallRecoveryRequiredError(
      "Installer service state cannot determine the effective user.",
    );
  }
  return uid;
}

function recoveryRequired(message: string): InstallRecoveryRequiredError {
  return new InstallRecoveryRequiredError(
    `Installer service state: ${message}`,
  );
}

/**
 * Durable state for a single root service process. The pre-provisioned root,
 * authorizations, and targets directories must all be owned by the service's
 * effective UID and inaccessible to group/other users. A production service
 * additionally enforces EUID 0 at its request boundary.
 */
export class DurableFileInstallServiceState
  implements InstallAuthorizationReplayStore, InstallTargetSerializer
{
  readonly directory: string;
  readonly authorizationsDirectory: string;
  readonly targetsDirectory: string;
  readonly maxAuthorizationRecords: number;

  constructor(
    directory: string,
    options: DurableFileInstallServiceStateOptions = {},
  ) {
    if (!directory.trim() || !isAbsolute(directory)) {
      throw new Error("Installer service state directory must be absolute.");
    }
    this.directory = resolve(directory);
    this.authorizationsDirectory = join(this.directory, "authorizations");
    this.targetsDirectory = join(this.directory, "targets");
    this.maxAuthorizationRecords =
      options.maxAuthorizationRecords ?? DEFAULT_MAX_AUTHORIZATION_RECORDS;
    if (
      !Number.isSafeInteger(this.maxAuthorizationRecords) ||
      this.maxAuthorizationRecords <= 0 ||
      this.maxAuthorizationRecords > DEFAULT_MAX_AUTHORIZATION_RECORDS
    ) {
      throw new Error("Installer authorization record quota is invalid.");
    }
  }

  private async assertDirectory(path: string): Promise<void> {
    let stats: Stats;
    try {
      stats = await lstat(path);
    } catch {
      throw recoveryRequired("a required state directory is unavailable.");
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      stats.uid !== operatingUid() ||
      (stats.mode & 0o777) !== OWNER_DIRECTORY_MODE
    ) {
      throw recoveryRequired(
        "directories must be real, owner-only, and owned by the service identity.",
      );
    }
  }

  private async assertTopology(): Promise<void> {
    const filesystemOwnerUid = (await lstat("/")).uid;
    let ancestor = this.directory;
    while (true) {
      let stats: Stats;
      try {
        stats = await lstat(ancestor);
      } catch {
        throw recoveryRequired("a state-path ancestor is unavailable.");
      }
      const writableByOthers = (stats.mode & 0o022) !== 0;
      const trustedStickyDirectory =
        stats.isDirectory() &&
        stats.uid === filesystemOwnerUid &&
        (stats.mode & 0o1000) !== 0;
      if (
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.uid !== operatingUid() && stats.uid !== filesystemOwnerUid) ||
        (writableByOthers && !trustedStickyDirectory)
      ) {
        throw recoveryRequired(
          "state-path ancestors must be trusted real directories that cannot be replaced by another user.",
        );
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    await this.assertDirectory(this.directory);
    await this.assertDirectory(this.authorizationsDirectory);
    await this.assertDirectory(this.targetsDirectory);
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async createExclusiveFile(
    path: string,
    payload: string,
  ): Promise<FileHandle | null> {
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        OWNER_FILE_MODE,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw recoveryRequired("could not create an exclusive state record.");
    }
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== operatingUid() ||
        (stats.mode & 0o777) !== OWNER_FILE_MODE
      ) {
        throw recoveryRequired(
          "new state records must be owner-only regular files with one link.",
        );
      }
      const bytes = Buffer.from(`${payload}\n`, "utf8");
      const result = await handle.write(bytes, 0, bytes.length, null);
      if (result.bytesWritten !== bytes.length) {
        throw recoveryRequired("state record was only partially written.");
      }
      await handle.sync();
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async claim(authorization: InstallAuthorization): Promise<boolean> {
    await this.assertTopology();
    if (
      !SHA256_PATTERN.test(authorization.planId) ||
      !SHA256_PATTERN.test(authorization.inventoryFingerprint) ||
      !authorization.ownerId.trim() ||
      authorization.ownerId.includes("\0") ||
      Buffer.byteLength(authorization.ownerId, "utf8") >
        MAX_AUTHORIZATION_ID_BYTES ||
      !authorization.nonce.trim() ||
      authorization.nonce.includes("\0") ||
      Buffer.byteLength(authorization.nonce, "utf8") >
        MAX_AUTHORIZATION_ID_BYTES ||
      !authorization.issuedAt.trim() ||
      Buffer.byteLength(authorization.issuedAt, "utf8") > MAX_TIMESTAMP_BYTES ||
      !authorization.expiresAt.trim() ||
      Buffer.byteLength(authorization.expiresAt, "utf8") > MAX_TIMESTAMP_BYTES
    ) {
      throw recoveryRequired(
        "authorization record fields are invalid or oversized.",
      );
    }
    for (const timestamp of [authorization.issuedAt, authorization.expiresAt]) {
      const parsed = Date.parse(timestamp);
      if (
        !Number.isFinite(parsed) ||
        new Date(parsed).toISOString() !== timestamp
      ) {
        throw recoveryRequired("authorization timestamps are not canonical.");
      }
    }
    const key = sha256(`${authorization.ownerId}\0${authorization.nonce}`);
    const path = join(this.authorizationsDirectory, `${key}.json`);
    const payload = JSON.stringify({
      schemaVersion: 1,
      ownerId: authorization.ownerId,
      nonce: authorization.nonce,
      planId: authorization.planId,
      inventoryFingerprint: authorization.inventoryFingerprint,
      issuedAt: authorization.issuedAt,
      expiresAt: authorization.expiresAt,
    });
    const quotaLockPath = join(this.directory, "authorizations.lock");
    const quotaLock = await this.createExclusiveFile(
      quotaLockPath,
      JSON.stringify({ schemaVersion: 1, operation: "authorization-claim" }),
    );
    if (quotaLock === null) {
      throw recoveryRequired(
        "authorization quota lock exists; concurrent or interrupted claim requires explicit recovery.",
      );
    }
    await quotaLock.close();
    await this.syncDirectory(this.directory);
    let result: boolean | undefined;
    let claimError: unknown;
    try {
      const records = await readdir(this.authorizationsDirectory);
      if (records.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))) {
        throw recoveryRequired(
          "authorization replay directory contains an unexpected record.",
        );
      }
      if (records.includes(`${key}.json`)) {
        result = false;
      } else {
        if (records.length >= this.maxAuthorizationRecords) {
          throw recoveryRequired(
            "authorization replay capacity is exhausted; records cannot be deleted without an explicit recovery policy.",
          );
        }
        const handle = await this.createExclusiveFile(path, payload);
        if (handle === null) {
          result = false;
        } else {
          await handle.close();
          await this.syncDirectory(this.authorizationsDirectory);
          result = true;
        }
      }
    } catch (error) {
      claimError = error;
    }
    try {
      await unlink(quotaLockPath);
      await this.syncDirectory(this.directory);
    } catch {
      throw recoveryRequired(
        "authorization quota lock cleanup was not durably completed; explicit recovery is required.",
      );
    }
    if (claimError !== undefined) throw claimError;
    if (result === undefined) {
      throw recoveryRequired("authorization claim did not reach a result.");
    }
    return result;
  }

  async runExclusive<T>(
    physicalIdentity: string,
    kernelDeviceIdentity: string | undefined,
    planId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      !SHA256_PATTERN.test(physicalIdentity) ||
      !SHA256_PATTERN.test(planId) ||
      (kernelDeviceIdentity !== undefined &&
        (!kernelDeviceIdentity.trim() ||
          kernelDeviceIdentity.includes("\0") ||
          Buffer.byteLength(kernelDeviceIdentity, "utf8") >
            MAX_KERNEL_IDENTITY_BYTES))
    ) {
      throw recoveryRequired("target lock identity is invalid.");
    }
    await this.assertTopology();
    const path = join(this.targetsDirectory, `${physicalIdentity}.lock`);
    const handle = await this.createExclusiveFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        physicalIdentity,
        kernelDeviceIdentity: kernelDeviceIdentity ?? null,
        planId,
      }),
    );
    if (handle === null) {
      throw recoveryRequired(
        "target lock already exists; concurrent or interrupted execution requires explicit recovery.",
      );
    }
    await handle.close();
    await this.syncDirectory(this.targetsDirectory);

    let result: T;
    try {
      result = await operation();
    } catch (error) {
      const failure = recoveryRequired(
        "target operation failed after lock acquisition; the lock is retained for explicit recovery.",
      );
      failure.cause = error;
      throw failure;
    }
    try {
      await unlink(path);
      await this.syncDirectory(this.targetsDirectory);
    } catch {
      throw recoveryRequired(
        "target lock cleanup was not durably completed; explicit recovery is required.",
      );
    }
    return result;
  }
}
