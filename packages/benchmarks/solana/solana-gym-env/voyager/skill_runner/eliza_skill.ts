import {
  AddressLookupTableProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

export async function executeSkill(blockhash: string): Promise<string> {
  const tx = new Transaction();
  const agentPubkey = new PublicKey(
    "CeR8n6jcoN2icKRG1we2TJB9YNApjw7PPyFYKNUjer5K",
  );
  const connection = new (await import("@solana/web3.js")).Connection(
    "http://localhost:8899",
  );

  // Get recent slot for lookup table creation
  const slot = await connection.getSlot();

  // Disc 0: CreateLookupTable
  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: agentPubkey,
      payer: agentPubkey,
      recentSlot: slot,
    });
  tx.add(createIx);

  // Disc 2: ExtendLookupTable (add some addresses)
  tx.add(
    AddressLookupTableProgram.extendLookupTable({
      payer: agentPubkey,
      authority: agentPubkey,
      lookupTable: lookupTableAddress,
      addresses: [
        new PublicKey("11111111111111111111111111111111"),
        new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      ],
    }),
  );

  // Disc 1: FreezeLookupTable
  tx.add(
    AddressLookupTableProgram.freezeLookupTable({
      authority: agentPubkey,
      lookupTable: lookupTableAddress,
    }),
  );

  tx.recentBlockhash = blockhash;
  tx.feePayer = agentPubkey;

  return tx
    .serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })
    .toString("base64");
}
