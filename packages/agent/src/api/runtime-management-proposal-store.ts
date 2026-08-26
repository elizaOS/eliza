/** Persists one-use runtime mutation proposals with cross-process atomic consumption. */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type Dir } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { logger, resolveStateDir } from "@elizaos/core";

const PROPOSAL_FILE_BYTES = 16 * 1024;
const CLEANUP_SCAN_LIMIT = 64;
const ABANDONED_FILE_AGE_MS = 10 * 60_000;
const PROPOSAL_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const CONSUMED_FILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.consumed-[0-9a-f-]{36}$/i;
const CLEANUP_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.cleanup-[0-9a-f-]{36}$/i;

export interface RuntimeManagementProposal {
  proposalId: string;
  nonce: string;
  clientId: string;
  requestKey: string;
  expiresAt: number;
}

export interface RuntimeManagementProposalStore {
  create(proposal: RuntimeManagementProposal): Promise<void>;
  consume(proposal: RuntimeManagementProposal): Promise<boolean>;
}

interface StoredProposal extends Omit<RuntimeManagementProposal, "nonce"> {
  nonceDigest: string;
}

function nonceDigest(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function equalDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
    return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isStoredProposal(value: unknown): value is StoredProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.proposalId === "string" &&
    typeof item.nonceDigest === "string" &&
    typeof item.clientId === "string" &&
    typeof item.requestKey === "string" &&
    typeof item.expiresAt === "number" &&
    Number.isSafeInteger(item.expiresAt)
  );
}

export class FileRuntimeManagementProposalStore
  implements RuntimeManagementProposalStore
{
  private readonly directory: string;
  private cleanupDirectory: Dir | undefined;
  private cleanupTail: Promise<void> = Promise.resolve();

  constructor(stateDirectory = resolveStateDir()) {
    this.directory = path.join(stateDirectory, "runtime-management-proposals");
  }

  private proposalPath(proposalId: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        proposalId,
      )
    ) {
      throw new TypeError("Runtime proposal id must be a UUID.");
    }
    return path.join(this.directory, `${proposalId}.json`);
  }

  private async prepareDirectory(create: boolean): Promise<boolean> {
    if (create) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
    }
    try {
      const metadata = await lstat(this.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(
          "Runtime proposal directory must be a real local directory.",
        );
      }
      return true;
    } catch (error) {
      // error-policy:J3 an absent store is an explicit consume miss; linked or
      // non-directory state fails closed instead of redirecting authority I/O.
      if (
        !create &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  async create(proposal: RuntimeManagementProposal): Promise<void> {
    await this.prepareDirectory(true);
    await this.cleanupStaleFiles();
    const stored: StoredProposal = {
      proposalId: proposal.proposalId,
      nonceDigest: nonceDigest(proposal.nonce),
      clientId: proposal.clientId,
      requestKey: proposal.requestKey,
      expiresAt: proposal.expiresAt,
    };
    const handle = await open(
      this.proposalPath(proposal.proposalId),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(stored), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readPath(
    filePath: string,
  ): Promise<StoredProposal | undefined> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > PROPOSAL_FILE_BYTES)
        return undefined;
      const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
      return isStoredProposal(parsed) ? parsed : undefined;
    } catch (error) {
      // error-policy:J3 missing, linked, oversized, or malformed proposal files
      // are invalid authority and are never followed outside the state store.
      if (
        error instanceof SyntaxError ||
        (error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ELOOP"))
      ) {
        return undefined;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private read(proposalId: string): Promise<StoredProposal | undefined> {
    return this.readPath(this.proposalPath(proposalId));
  }

  private async cleanupProposalFile(
    fileName: string,
    now: number,
  ): Promise<void> {
    const proposalMatch = PROPOSAL_FILE_PATTERN.exec(fileName);
    const cleanupMatch = CLEANUP_FILE_PATTERN.exec(fileName);
    const filePath = path.join(this.directory, fileName);
    const metadata = await lstat(filePath);
    if (cleanupMatch) {
      if (metadata.mtimeMs > now - ABANDONED_FILE_AGE_MS) return;
      const claimed = await this.readPath(filePath);
      if (claimed && claimed.expiresAt > now) {
        try {
          await link(
            filePath,
            path.join(this.directory, `${cleanupMatch[1]}.json`),
          );
        } catch (error) {
          // error-policy:J6 an original path means another recovery or exact
          // same-id publisher already retained the authoritative proposal.
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            )
          ) {
            throw error;
          }
        }
      }
      await unlink(filePath);
      return;
    }
    if (CONSUMED_FILE_PATTERN.test(fileName)) {
      if (metadata.mtimeMs <= now - ABANDONED_FILE_AGE_MS)
        await unlink(filePath);
      return;
    }
    if (!proposalMatch) return;
    const stored = await this.readPath(filePath);
    if (
      (stored && stored.expiresAt > now) ||
      (!stored && metadata.mtimeMs > now - ABANDONED_FILE_AGE_MS)
    ) {
      return;
    }

    const claimedPath = path.join(
      this.directory,
      `${proposalMatch[1]}.cleanup-${randomUUID()}`,
    );
    await rename(filePath, claimedPath);
    try {
      const claimedMetadata = await lstat(claimedPath);
      const claimed = await this.readPath(claimedPath);
      const stale = claimed
        ? claimed.expiresAt <= now
        : claimedMetadata.mtimeMs <= now - ABANDONED_FILE_AGE_MS;
      if (!stale) {
        try {
          await link(claimedPath, filePath);
        } catch (error) {
          // error-policy:J6 a concurrent same-id publisher already restored a
          // proposal path, so the cleanup claim must not replace it.
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            )
          ) {
            throw error;
          }
        }
      }
    } finally {
      await unlink(claimedPath).catch((error) => {
        // error-policy:J6 another cleanup may already have removed the claim.
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      });
    }
  }

  private async cleanupStaleFilesSerialized(now: number): Promise<void> {
    try {
      this.cleanupDirectory ??= await opendir(this.directory);
      let scanned = 0;
      while (scanned < CLEANUP_SCAN_LIMIT) {
        const entry = await this.cleanupDirectory.read();
        if (!entry) {
          await this.cleanupDirectory.close();
          this.cleanupDirectory = undefined;
          break;
        }
        scanned += 1;
        await this.cleanupProposalFile(entry.name, now).catch((error) => {
          // error-policy:J6 bounded maintenance failure is visible but cannot
          // prevent an unrelated exact proposal from being created or used.
          logger.warn(
            { fileName: entry.name, error },
            "[RuntimeManagementProposalStore] Stale cleanup failed",
          );
        });
      }
    } catch (error) {
      await this.cleanupDirectory?.close().catch((closeError) => {
        // error-policy:J6 best-effort scan teardown retains a structured
        // warning while the original scan failure remains authoritative.
        logger.warn(
          { closeError },
          "[RuntimeManagementProposalStore] Cleanup close failed",
        );
      });
      this.cleanupDirectory = undefined;
      // error-policy:J6 the directory may not exist before the first proposal;
      // other scan failures are reported without disabling exact authority.
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        logger.warn(
          { error },
          "[RuntimeManagementProposalStore] Cleanup scan failed",
        );
      }
    }
  }

  private cleanupStaleFiles(now = Date.now()): Promise<void> {
    const cleanup = this.cleanupTail.then(() =>
      this.cleanupStaleFilesSerialized(now),
    );
    this.cleanupTail = cleanup;
    return cleanup;
  }

  async consume(proposal: RuntimeManagementProposal): Promise<boolean> {
    if (!(await this.prepareDirectory(false))) return false;
    await this.cleanupStaleFiles();
    const stored = await this.read(proposal.proposalId);
    if (!stored) return false;
    if (stored.expiresAt <= Date.now()) {
      await unlink(this.proposalPath(proposal.proposalId)).catch((error) => {
        // error-policy:J6 another process may have consumed the expired record.
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      });
      return false;
    }
    if (
      stored.clientId !== proposal.clientId ||
      stored.requestKey !== proposal.requestKey ||
      !equalDigest(stored.nonceDigest, nonceDigest(proposal.nonce))
    ) {
      return false;
    }

    const claimedPath = path.join(
      this.directory,
      `${proposal.proposalId}.consumed-${randomUUID()}`,
    );
    try {
      await rename(this.proposalPath(proposal.proposalId), claimedPath);
    } catch (error) {
      // error-policy:J3 a concurrent winner makes this consume an explicit miss.
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
    try {
      const claimed = await this.readPath(claimedPath);
      return (
        claimed !== undefined &&
        claimed.expiresAt > Date.now() &&
        claimed.clientId === proposal.clientId &&
        claimed.requestKey === proposal.requestKey &&
        equalDigest(claimed.nonceDigest, nonceDigest(proposal.nonce))
      );
    } finally {
      await unlink(claimedPath);
    }
  }
}
