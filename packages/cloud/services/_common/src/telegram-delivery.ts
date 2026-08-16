/**
 * Exact-once Telegram reply boundary shared by edge and gateway runtimes.
 * The backing ledger must provide atomic claims; the state machine writes an
 * irreversible egress marker before contacting Telegram so an ambiguous send
 * can never be replayed as a duplicate response.
 */

export type TelegramDeliveryState = "egress_started" | "delivered";

export interface TelegramDeliveryLedger {
  read(): Promise<TelegramDeliveryState | null>;
  claimProcessing(): Promise<boolean>;
  releaseProcessing(): Promise<void>;
  claimEgress(): Promise<boolean>;
  markDelivered(): Promise<void>;
}

export type TelegramDeliveryOutcome =
  | "delivered"
  | "duplicate"
  | "in_progress"
  | "uncertain";

export class TelegramEgressAlreadyClaimedError extends Error {
  override readonly name = "TelegramEgressAlreadyClaimedError";
}

export async function executeTelegramDelivery(
  ledger: TelegramDeliveryLedger,
  deliver: (beforeEgress: () => Promise<void>) => Promise<void>,
): Promise<TelegramDeliveryOutcome> {
  const prior = await ledger.read();
  if (prior === "egress_started") return "uncertain";
  if (prior === "delivered") return "duplicate";
  if (!(await ledger.claimProcessing())) return "in_progress";

  let egressStarted = false;
  try {
    await deliver(async () => {
      if (!(await ledger.claimEgress())) {
        throw new TelegramEgressAlreadyClaimedError(
          "Telegram egress was already claimed for this update",
        );
      }
      egressStarted = true;
    });
    await ledger.markDelivered();
    return "delivered";
  } finally {
    if (!egressStarted) await ledger.releaseProcessing();
  }
}
