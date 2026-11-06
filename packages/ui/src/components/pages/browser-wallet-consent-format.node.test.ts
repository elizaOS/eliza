import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  decodeSignableMessage,
  describeEvmCallData,
  describeSolanaTransaction,
} from "./browser-wallet-consent-format.ts";

test("decodes a 0X-prefixed personal_sign payload for the consent preview", () => {
  assert.equal(decodeSignableMessage("0x4869"), "Hi");
  // EIP-1193 hex prefixes are case-insensitive. 0X currently stays hex,
  // so the sign dialog shows "0X4869" instead of the text "Hi".
  assert.equal(decodeSignableMessage("0X4869"), "Hi");
  assert.equal(decodeSignableMessage(" \t0X4869\n"), "Hi");
});

test("leaves a non-hex 0X payload unchanged", () => {
  assert.equal(decodeSignableMessage("0X686"), "0X686");
  assert.equal(decodeSignableMessage("0X68zz"), "0X68zz");
  assert.equal(decodeSignableMessage("Sign this"), "Sign this");
  assert.equal(decodeSignableMessage("  Sign this  "), "  Sign this  ");
  assert.equal(decodeSignableMessage("  0X68zz  "), "  0X68zz  ");
});

const ATTACKER = "1111111111111111111111111111111111111111";
const word = (hex: string) => hex.padStart(64, "0");

test("shows the recipient and amount of a token transfer hidden behind Value: 0", () => {
  const data = `0xa9059cbb${word(ATTACKER)}${word(5_000_000n.toString(16))}`;
  assert.deepEqual(describeEvmCallData(data), [
    "Token transfer from this contract",
    `Recipient: 0x${ATTACKER}`,
    "Amount: 5000000 (token base units)",
  ]);
});

test("names an unlimited token approval", () => {
  const lines = describeEvmCallData(
    `0x095ea7b3${word(ATTACKER)}${"f".repeat(64)}`,
  );
  assert.match(lines[0] ?? "", /Token approval/);
  assert.ok(lines.includes("Amount: Unlimited"));
});

test("warns about call data it cannot decode, and stays silent for a plain send", () => {
  assert.deepEqual(describeEvmCallData("0xdeadbeef00"), [
    "Contract call 0xdeadbeef with 5 bytes of data.",
    "Eliza cannot show what this call does. Only allow it if you trust this site.",
  ]);
  assert.deepEqual(describeEvmCallData(undefined), []);
  assert.deepEqual(describeEvmCallData("0x"), []);
});

const payer = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const encode = (instructions: TransactionInstruction[]) =>
  btoa(
    String.fromCharCode(
      ...new VersionedTransaction(
        new TransactionMessage({
          payerKey: payer,
          recentBlockhash: PublicKey.default.toBase58(),
          instructions,
        }).compileToV0Message(),
      ).serialize(),
    ),
  );

test("lists the recipient and amount of a Solana SOL transfer", async () => {
  const tx = encode([
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: recipient,
      lamports: 2_500_000_000,
    }),
  ]);
  assert.deepEqual(await describeSolanaTransaction(tx), [
    `Send 2.5 SOL to ${recipient.toBase58()}`,
  ]);
});

test("warns when a Solana transaction calls a program it cannot describe", async () => {
  const tx = encode([
    {
      programId: Keypair.generate().publicKey,
      keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3]),
    },
  ]);
  const lines = await describeSolanaTransaction(tx);
  assert.match(lines.at(-1) ?? "", /cannot show everything/);
});
