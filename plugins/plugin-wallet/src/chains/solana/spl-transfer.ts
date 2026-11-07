import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * Instructions that move `amount` base units of `mint` from `owner` to
 * `recipient`, creating the recipient's token account when it is missing.
 * The token accounts and the transfer use the program that owns the mint, so
 * Token-2022 mints (PYUSD, pump.fun create_v2 coins) transfer like classic SPL
 * mints. `transferChecked` is the form Token-2022 extensions such as transfer
 * fees accept.
 */
export async function buildSplTransferInstructions(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  recipient: PublicKey,
  amount: bigint,
  decimals: number
): Promise<TransactionInstruction[]> {
  const mintAccount = await connection.getAccountInfo(mint);
  const programId = mintAccount?.owner;
  if (
    !programId ||
    !(programId.equals(TOKEN_PROGRAM_ID) || programId.equals(TOKEN_2022_PROGRAM_ID))
  ) {
    throw new Error(`${mint.toBase58()} is not an SPL token mint.`);
  }
  const senderAta = getAssociatedTokenAddressSync(mint, owner, false, programId);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient, false, programId);
  const instructions: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(recipientAta))) {
    instructions.push(
      createAssociatedTokenAccountInstruction(owner, recipientAta, recipient, mint, programId)
    );
  }
  instructions.push(
    createTransferCheckedInstruction(
      senderAta,
      mint,
      recipientAta,
      owner,
      amount,
      decimals,
      [],
      programId
    )
  );
  return instructions;
}
