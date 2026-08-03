import { EthereumTransaction } from "../moralis";
import { ParsedWalletTransaction } from "./transaction";

// Moralis's /wallets/{address}/history endpoint returns pre-decoded
// native_transfers[] and erc20_transfers[] per transaction - live-confirmed
// (see moralis.ts's header comment) to cover plain native sends, ERC-20
// transfers, and multi-leg contract interactions (native ETH moved via a
// contract call shows up in native_transfers with internal_transaction:
// true, no separate internal_transactions decoding needed). This mirrors
// parseSolanaTransaction()'s role: a thin reshape of an already-decoded
// source into the chain-neutral ParsedWalletTransaction shape, not a
// from-scratch decoder.
export function parseEthereumTransaction(
  transaction: EthereumTransaction | null | undefined,
): ParsedWalletTransaction {
  const nativeTransfers = (transaction?.nativeTransfers ?? []).map(
    (transfer) => ({
      from: transfer.from_address ?? null,
      to: transfer.to_address ?? null,
      amountNative:
        typeof transfer.value_formatted === "string"
          ? Number(transfer.value_formatted)
          : null,
    }),
  );

  const tokenTransfers = (transaction?.tokenTransfers ?? []).map(
    (transfer) => ({
      from: transfer.from_address ?? null,
      to: transfer.to_address ?? null,
      contractAddress: transfer.address ?? null,
      amount:
        typeof transfer.value_formatted === "string"
          ? Number(transfer.value_formatted)
          : null,
    }),
  );

  // Addresses are lowercased before being added: Moralis returns
  // checksummed (mixed-case) addresses, but the protocol registry
  // (protocols/ethereum/*.ts) stores its keys lowercase, and
  // lookupProtocol() does an exact string match with no case
  // normalization of its own - without this, every registry lookup
  // would silently miss.
  const programOrContractIds = new Set<string>();

  if (transaction?.toAddress) {
    programOrContractIds.add(transaction.toAddress.toLowerCase());
  }

  for (const transfer of transaction?.tokenTransfers ?? []) {
    if (transfer.address) {
      programOrContractIds.add(transfer.address.toLowerCase());
    }
  }

  // Shape unconfirmed live - read defensively across every plausible
  // field name so this degrades to "contributes nothing extra" rather
  // than throwing if the real shape differs.
  for (const interaction of transaction?.contractInteractions ?? []) {
    const address =
      interaction.address ??
      interaction.contract_address ??
      interaction.spender;

    if (typeof address === "string" && address.length > 0) {
      programOrContractIds.add(address.toLowerCase());
    }
  }

  return {
    signature: transaction?.hash ?? null,
    timestamp: transaction?.blockTimestamp ?? null,
    nativeTransfers,
    tokenTransfers,
    programOrContractIds: Array.from(programOrContractIds),
  };
}
