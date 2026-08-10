import {
  BlockchairTransactionDetail,
  parseBlockchairTimestamp,
} from "../blockchair";
import { ParsedWalletTransaction } from "./transaction";

const SATOSHIS_PER_BTC = 100_000_000;

// Unlike parseEthereumTransaction/parseSolanaTransaction, this needs a
// second argument: Bitcoin transactions have no explicit sender/receiver
// (see the transaction-parsing design investigation) - inputs are who's
// spending, outputs are who's receiving, and there's no field marking
// which output (if any) is "change" back to the sender rather than a real
// second recipient. ownedAddresses is what makes this tractable: for an
// xpub wallet, it's the full derived-address set (chains/bitcoin.ts's
// deriveAddresses()), so any output landing on one of our OWN other
// addresses is definitively not an external transfer, not a heuristic -
// we know those addresses are ours. For a single-address investigation,
// ownedAddresses has exactly one member, and change-output ambiguity on
// the OUTGOING side stays a real, unsolved limitation (see the caller's
// transparency note) - there's no way to prove an unfamiliar output
// address is our own untracked change vs. a genuine second recipient.
// Incoming transfers have no such ambiguity either way: input recipients
// are unambiguous regardless of how many addresses we're tracking.
export function parseBitcoinTransaction(
  transaction: BlockchairTransactionDetail | null | undefined,
  ownedAddresses: ReadonlySet<string>,
): ParsedWalletTransaction {
  if (!transaction) {
    return {
      signature: null,
      timestamp: null,
      nativeTransfers: [],
      tokenTransfers: [],
      programOrContractIds: [],
    };
  }

  const nativeTransfers = buildBitcoinNativeTransfers(
    transaction,
    ownedAddresses,
  );

  return {
    signature: transaction.hash,
    timestamp: parseBlockchairTimestamp(transaction.time),
    nativeTransfers,
    // Bitcoin has no token standard of its own (see chains/bitcoin.ts) -
    // Ordinals/BRC-20 are a separate, out-of-scope ecosystem.
    tokenTransfers: [],
    programOrContractIds: [],
  };
}

function buildBitcoinNativeTransfers(
  transaction: BlockchairTransactionDetail,
  ownedAddresses: ReadonlySet<string>,
): ParsedWalletTransaction["nativeTransfers"] {
  const transfers: ParsedWalletTransaction["nativeTransfers"] = [];

  const externalInputs = transaction.inputs.filter(
    (input) => input.recipient && !ownedAddresses.has(input.recipient),
  );
  const ownedInputs = transaction.inputs.filter(
    (input) => input.recipient && ownedAddresses.has(input.recipient),
  );
  const ownedOutputs = transaction.outputs.filter(
    (output) => output.recipient && ownedAddresses.has(output.recipient),
  );
  const externalOutputs = transaction.outputs.filter(
    (output) => output.recipient && !ownedAddresses.has(output.recipient),
  );

  // Incoming: real external funds landed on one of our addresses. A
  // transaction can have multiple inputs (multiple co-signers, in the
  // rare case), but this attributes the whole received amount to a single
  // "primary" sender - the largest external input by value - rather than
  // generating one transfer record per input, which would double-count
  // the received amount if summed downstream. A documented simplification,
  // not a promise of perfect multi-party attribution.
  if (ownedOutputs.length > 0 && externalInputs.length > 0) {
    const primarySender = externalInputs.reduce((largest, input) =>
      (input.value ?? 0) > (largest.value ?? 0) ? input : largest,
    );

    for (const output of ownedOutputs) {
      if (!primarySender.recipient || !output.recipient) {
        continue;
      }

      transfers.push({
        from: primarySender.recipient,
        to: output.recipient,
        amountNative: (output.value ?? 0) / SATOSHIS_PER_BTC,
      });
    }
  }

  // Outgoing: we initiated this (at least one input is ours). Every
  // output NOT landing on one of our own addresses is treated as a real
  // transfer out - for xpub wallets this correctly excludes change
  // (change addresses are, by definition, in ownedAddresses); for a
  // single tracked address, an output to an address we don't happen to
  // be tracking is indistinguishable from real change here, and is
  // recorded as if it were a real transfer - the disclosed limitation.
  if (ownedInputs.length > 0 && externalOutputs.length > 0) {
    const primarySpender = ownedInputs.reduce((largest, input) =>
      (input.value ?? 0) > (largest.value ?? 0) ? input : largest,
    );

    for (const output of externalOutputs) {
      if (!primarySpender.recipient || !output.recipient) {
        continue;
      }

      transfers.push({
        from: primarySpender.recipient,
        to: output.recipient,
        amountNative: (output.value ?? 0) / SATOSHIS_PER_BTC,
      });
    }
  }

  return transfers;
}
