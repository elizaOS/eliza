import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { encodeFunctionData, maxUint256, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { resolveBrowserWorkspaceVaultAutofill } from "./browser-workspace-host-identity";
import {
  summarizeEvmTransaction,
  summarizeSolanaTransaction,
} from "./browser-workspace-tx-summary";

const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SPENDER = "0x1111111111111111111111111111111111111111";
const ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function setApprovalForAll(address operator, bool approved)",
]);

describe("browser wallet transaction consent", () => {
  it("shows the full checksummed To address and no warning for a plain send", () => {
    const summary = summarizeEvmTransaction({ to: TOKEN, data: "0x" });
    expect(summary.lines).toEqual([
      "To: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    ]);
    expect(summary.warning).toBeNull();
  });

  it("decodes approve(spender, max) as an unlimited approval", () => {
    const data = encodeFunctionData({
      abi: ABI,
      functionName: "approve",
      args: [SPENDER, maxUint256],
    });
    const summary = summarizeEvmTransaction({ to: TOKEN, data });
    expect(summary.lines).toContain("Contract call: approve (0x095ea7b3)");
    expect(summary.lines).toContain(`Spender: ${SPENDER}`);
    expect(summary.lines).toContain("Amount: unlimited");
    expect(summary.warning).toMatch(/move all of this token/);
  });

  it("flags setApprovalForAll(operator, true)", () => {
    const data = encodeFunctionData({
      abi: ABI,
      functionName: "setApprovalForAll",
      args: [SPENDER, true],
    });
    const summary = summarizeEvmTransaction({ to: TOKEN, data });
    expect(summary.lines).toContain(`Operator: ${SPENDER}`);
    expect(summary.warning).toMatch(/every item/);
  });

  it("shows raw calldata and a blind-signing warning for an unknown call", () => {
    const summary = summarizeEvmTransaction({
      to: TOKEN,
      data: "0xdeadbeef0000000000000000000000000000000000000000000000000000000000000001",
    });
    expect(summary.lines).toContain(
      "Contract call: unknown function (0xdeadbeef)",
    );
    expect(
      summary.lines.some((line) => line.startsWith("Data: 0xdeadbeef")),
    ).toBe(true);
    expect(summary.warning).toMatch(/cannot read what this does/);
  });

  it("decodes a Solana SOL transfer and warns on an unknown program", async () => {
    const payer = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const unknownProgram = Keypair.generate().publicKey;
    const encode = (instructions: TransactionInstruction[]) =>
      Buffer.from(
        new VersionedTransaction(
          new TransactionMessage({
            payerKey: payer,
            recentBlockhash: PublicKey.default.toBase58(),
            instructions,
          }).compileToV0Message(),
        ).serialize(),
      ).toString("base64");
    const transfer = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: recipient,
      lamports: 1_500_000_000,
    });

    const plain = await summarizeSolanaTransaction(encode([transfer]));
    expect(plain.lines).toEqual([
      `Transfer 1.5 SOL to ${recipient.toBase58()}`,
    ]);
    expect(plain.warning).toBeNull();

    const blind = await summarizeSolanaTransaction(
      encode([
        transfer,
        new TransactionInstruction({
          programId: unknownProgram,
          keys: [],
          data: Buffer.from([1, 2, 3]),
        }),
      ]),
    );
    expect(blind.lines).toContain(`Call program ${unknownProgram.toBase58()}`);
    expect(blind.warning).toMatch(/cannot read what this does/);

    const garbage = await summarizeSolanaTransaction("not-a-transaction");
    expect(garbage.warning).toMatch(/cannot read what this does/);
  });
});

describe("browser vault autofill identity", () => {
  it("resolves against the tab URL, not the page's claimed domain", async () => {
    const listed: string[] = [];
    const outcome = await resolveBrowserWorkspaceVaultAutofill(
      {
        topFrame: true,
        claimedDomain: "bank.example",
        fieldHints: [{ kind: "password", selector: "#p" }],
      },
      {
        readTabUrl: () => "https://evil.example/",
        listSavedLogins: async (domain) => {
          listed.push(domain);
          return { logins: [] };
        },
        getAutofillAllowed: async () => true,
        confirm: async () => true,
        revealSavedLogin: async () => ({ username: "u", password: "p" }),
      },
    );
    expect("refused" in outcome).toBe(true);
    expect(listed).toEqual([]);
  });
});
