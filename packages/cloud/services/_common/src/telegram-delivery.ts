/**
 * Exact-once Telegram reply boundary shared by edge and gateway runtimes.
 * The ledger stores only deterministic chunk digests and delivery state, never
 * reply text or credentials. Provider rejections reopen only the rejected
 * chunk; transport ambiguity remains irreversible so retries cannot duplicate
 * a reply Telegram may already have accepted.
 */

export type TelegramDeliveryState = "uncertain" | "delivered";

export interface TelegramDeliveryLedger {
  read(): Promise<TelegramDeliveryState | null>;
  claimProcessing(): Promise<boolean>;
  releaseProcessing(): Promise<void>;
  preparePlan(
    chunkDigests: readonly string[],
  ): Promise<"prepared" | "conflict">;
  readChunk(
    chunkIndex: number,
    chunkDigest: string,
  ): Promise<TelegramDeliveryState | null>;
  claimChunk(chunkIndex: number, chunkDigest: string): Promise<boolean>;
  releaseChunk(chunkIndex: number, chunkDigest: string): Promise<void>;
  markChunkDelivered(
    chunkIndex: number,
    chunkDigest: string,
    providerMessageId?: string,
  ): Promise<void>;
  markDelivered(): Promise<void>;
}

export interface TelegramDeliveryHooks {
  prepare(chunks: readonly string[]): Promise<void>;
  shouldSend(chunkIndex: number, chunk: string): Promise<boolean>;
  accepted(
    chunkIndex: number,
    chunk: string,
    providerMessageId: string,
  ): Promise<void>;
  rejected(chunkIndex: number, chunk: string): Promise<void>;
}

export type TelegramDeliveryOutcome =
  | "delivered"
  | "duplicate"
  | "in_progress"
  | "uncertain";

export class TelegramEgressAlreadyClaimedError extends Error {
  override readonly name = "TelegramEgressAlreadyClaimedError";
}

export class TelegramDeliveryPlanConflictError extends Error {
  override readonly name = "TelegramDeliveryPlanConflictError";
}

async function chunkDigest(chunk: string): Promise<string> {
  const bytes = new TextEncoder().encode(chunk);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function executeTelegramDelivery(
  ledger: TelegramDeliveryLedger,
  deliver: (hooks: TelegramDeliveryHooks) => Promise<void>,
): Promise<TelegramDeliveryOutcome> {
  const prior = await ledger.read();
  if (prior === "uncertain") return "uncertain";
  if (prior === "delivered") return "duplicate";
  if (!(await ledger.claimProcessing())) return "in_progress";

  let digests: string[] | null = null;
  let activeChunk: { index: number; digest: string } | null = null;
  const requireChunk = (index: number): string => {
    const digest = digests?.[index];
    if (!digest) {
      throw new Error("Telegram delivery chunk was not in the prepared plan");
    }
    return digest;
  };

  const hooks: TelegramDeliveryHooks = {
    async prepare(chunks) {
      const nextDigests = await Promise.all(chunks.map(chunkDigest));
      if ((await ledger.preparePlan(nextDigests)) === "conflict") {
        throw new TelegramDeliveryPlanConflictError(
          "Telegram reply changed after delivery began",
        );
      }
      digests = nextDigests;
    },
    async shouldSend(index) {
      const digest = requireChunk(index);
      const state = await ledger.readChunk(index, digest);
      if (state === "delivered") return false;
      if (state === "uncertain") {
        throw new TelegramEgressAlreadyClaimedError(
          "Telegram chunk egress outcome is uncertain",
        );
      }
      if (!(await ledger.claimChunk(index, digest))) {
        const claimedState = await ledger.readChunk(index, digest);
        if (claimedState === "delivered") return false;
        throw new TelegramEgressAlreadyClaimedError(
          "Telegram chunk egress was already claimed",
        );
      }
      activeChunk = { index, digest };
      return true;
    },
    async accepted(index, _chunk, providerMessageId) {
      const digest = requireChunk(index);
      if (activeChunk?.index !== index || activeChunk.digest !== digest) {
        throw new Error("Telegram accepted an unclaimed delivery chunk");
      }
      await ledger.markChunkDelivered(index, digest, providerMessageId);
      activeChunk = null;
    },
    async rejected(index) {
      const digest = requireChunk(index);
      if (activeChunk?.index !== index || activeChunk.digest !== digest) {
        throw new Error("Telegram rejected an unclaimed delivery chunk");
      }
      await ledger.releaseChunk(index, digest);
      activeChunk = null;
    },
  };

  try {
    await deliver(hooks);
    await ledger.markDelivered();
    return "delivered";
  } finally {
    if (!activeChunk) await ledger.releaseProcessing();
  }
}
