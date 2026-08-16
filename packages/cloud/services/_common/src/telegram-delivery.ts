/**
 * Durable Telegram reply delivery state shared by edge and gateway runtimes.
 * Ledgers fence every mutation with a renewable owner token and persist the
 * multipart plan, cursor, and provider receipts before reporting completion.
 */

export interface TelegramDeliveryPlan {
  contentDigest: string;
  chunks: readonly string[];
}

export interface TelegramDeliveryProgress {
  state: "pending" | "egress_started" | "delivered";
  contentDigest: string;
  totalChunks: number;
  nextChunkIndex: number;
  providerMessageIds: readonly string[];
  activeChunkIndex?: number;
}

export type TelegramProviderSendOutcome =
  | { acceptance: "accepted"; providerMessageId: string }
  | {
      acceptance: "not_accepted";
      errorCode: number;
      retryAfterSeconds?: number;
    }
  | { acceptance: "unknown" };

export interface TelegramDeliveryLedger {
  read(): Promise<TelegramDeliveryProgress | null>;
  claimProcessing(ownerToken: string, leaseMs: number): Promise<boolean>;
  renewProcessing(ownerToken: string, leaseMs: number): Promise<boolean>;
  releaseProcessing(ownerToken: string): Promise<void>;
  preparePlan(
    ownerToken: string,
    plan: Pick<TelegramDeliveryProgress, "contentDigest" | "totalChunks">,
  ): Promise<TelegramDeliveryProgress>;
  claimChunk(ownerToken: string, chunkIndex: number): Promise<boolean>;
  recordAccepted(
    ownerToken: string,
    chunkIndex: number,
    providerMessageId: string,
  ): Promise<void>;
  recordExplicitRejection(
    ownerToken: string,
    chunkIndex: number,
  ): Promise<void>;
  markDelivered(ownerToken: string): Promise<void>;
}

export type TelegramDeliveryOutcome =
  | { status: "delivered"; providerMessageIds: readonly string[] }
  | { status: "duplicate"; providerMessageIds: readonly string[] }
  | { status: "in_progress" }
  | { status: "uncertain"; chunkIndex: number }
  | {
      status: "explicitly_rejected";
      chunkIndex: number;
      errorCode: number;
      retryAfterSeconds?: number;
    };

export type TelegramDeliveryDispatch = (
  plan: TelegramDeliveryPlan,
  sendChunk: (
    chunk: string,
    chunkIndex: number,
  ) => Promise<TelegramProviderSendOutcome>,
) => Promise<void>;

const DEFAULT_LEASE_MS = 120_000;
const MIN_RENEW_INTERVAL_MS = 1_000;

function ownerToken(): string {
  return crypto.randomUUID();
}

function terminalOutcome(
  progress: TelegramDeliveryProgress,
): TelegramDeliveryOutcome | null {
  if (progress.state === "delivered") {
    return {
      status: "duplicate",
      providerMessageIds: progress.providerMessageIds,
    };
  }
  if (progress.state === "egress_started") {
    return {
      status: "uncertain",
      chunkIndex: progress.activeChunkIndex ?? progress.nextChunkIndex,
    };
  }
  return null;
}

export async function executeTelegramDelivery(
  ledger: TelegramDeliveryLedger,
  deliver: (dispatch: TelegramDeliveryDispatch) => Promise<void>,
  options: { leaseMs?: number } = {},
): Promise<TelegramDeliveryOutcome> {
  const prior = await ledger.read();
  if (prior) {
    const terminal = terminalOutcome(prior);
    if (terminal) return terminal;
  }

  const owner = ownerToken();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!(await ledger.claimProcessing(owner, leaseMs))) {
    return { status: "in_progress" };
  }

  let leaseLost = false;
  const renewTimer = setInterval(
    () => {
      void ledger
        .renewProcessing(owner, leaseMs)
        .then((renewed) => {
          if (!renewed) leaseLost = true;
        })
        .catch(() => {
          // error-policy:J5 the delivery path observes this as a lost lease.
          leaseLost = true;
        });
    },
    Math.max(MIN_RENEW_INTERVAL_MS, Math.floor(leaseMs / 3)),
  );

  let dispatchOutcome: TelegramDeliveryOutcome | null = null;
  let dispatched = false;
  try {
    await deliver(async (plan, sendChunk) => {
      if (dispatched) throw new Error("Telegram reply was dispatched twice");
      dispatched = true;
      if (leaseLost) throw new Error("Telegram processing claim was lost");

      let progress = await ledger.preparePlan(owner, {
        contentDigest: plan.contentDigest,
        totalChunks: plan.chunks.length,
      });
      if (
        progress.contentDigest !== plan.contentDigest ||
        progress.totalChunks !== plan.chunks.length
      ) {
        throw new Error("Telegram delivery plan conflicts with persisted plan");
      }

      for (
        let chunkIndex = progress.nextChunkIndex;
        chunkIndex < plan.chunks.length;
        chunkIndex += 1
      ) {
        if (leaseLost) throw new Error("Telegram processing claim was lost");
        if (!(await ledger.claimChunk(owner, chunkIndex))) {
          progress = (await ledger.read()) ?? progress;
          dispatchOutcome =
            terminalOutcome(progress) ?? ({ status: "in_progress" } as const);
          return;
        }

        const result = await sendChunk(plan.chunks[chunkIndex], chunkIndex);
        if (result.acceptance === "unknown") {
          dispatchOutcome = { status: "uncertain", chunkIndex };
          return;
        }
        if (result.acceptance === "not_accepted") {
          await ledger.recordExplicitRejection(owner, chunkIndex);
          dispatchOutcome = {
            status: "explicitly_rejected",
            chunkIndex,
            errorCode: result.errorCode,
            ...(result.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: result.retryAfterSeconds }),
          };
          return;
        }
        await ledger.recordAccepted(
          owner,
          chunkIndex,
          result.providerMessageId,
        );
        progress = (await ledger.read()) ?? progress;
      }
    });

    if (dispatchOutcome) return dispatchOutcome;
    if (!dispatched) {
      await ledger.preparePlan(owner, { contentDigest: "", totalChunks: 0 });
    }
    await ledger.markDelivered(owner);
    const completed = await ledger.read();
    return {
      status: "delivered",
      providerMessageIds: completed?.providerMessageIds ?? [],
    };
  } finally {
    clearInterval(renewTimer);
    await ledger.releaseProcessing(owner);
  }
}
