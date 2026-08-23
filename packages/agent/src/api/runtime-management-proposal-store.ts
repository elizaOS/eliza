/** Persists one-use runtime mutation proposals with cross-process atomic consumption. */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";

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

  constructor(stateDirectory = resolveStateDir()) {
    this.directory = path.join(stateDirectory, "runtime-management-proposals");
  }

  private proposalPath(proposalId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(proposalId)) {
      throw new TypeError("Runtime proposal id must be a UUID.");
    }
    return path.join(this.directory, `${proposalId}.json`);
  }

  async create(proposal: RuntimeManagementProposal): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
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

  private async read(proposalId: string): Promise<StoredProposal | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(this.proposalPath(proposalId), "utf8"),
      ) as unknown;
      return isStoredProposal(parsed) ? parsed : undefined;
    } catch (error) {
      // error-policy:J3 missing or malformed proposal files are invalid authority.
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async consume(proposal: RuntimeManagementProposal): Promise<boolean> {
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
      const claimed = JSON.parse(
        await readFile(claimedPath, "utf8"),
      ) as unknown;
      return (
        isStoredProposal(claimed) &&
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
