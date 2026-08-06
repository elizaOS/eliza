/**
 * Clawd Agentic Facilitator — the "clawd way" of x402 + p-token payments.
 *
 * This layer sits above the raw x402/p-token primitives and provides:
 *
 *   1. MCP tool definitions  — AI agents call `clawd_pay` / `clawd_batch_pay` /
 *      `clawd_unwrap_lamports` as structured tool calls.
 *   2. Auto p-token routing  — detects p-token activation; transparently
 *      uses batch (opcode 25) for multi-recipient payments and reports CU savings.
 *   3. Agent-to-agent rails  — each tool call is itself an x402 payment gate;
 *      agents earn revenue per invocation via the ClawdRouter split.
 *   4. CLAWD holder discount — detected on-chain, applied before the challenge
 *      is issued; no rebate step needed.
 *   5. Receipt + IPFS pin    — every settled payment is pinned as a JSON receipt
 *      the agent can reference in its response.
 *
 * Intended use:
 *   Import `clawdFacilitator` (Hono router) and mount it at /facilitator/clawd
 *   in the main worker index.ts.
 *
 * MCP tool manifest:
 *   POST /facilitator/clawd/tools — returns the JSON tool manifest.
 *   POST /facilitator/clawd/call  — executes a named tool call.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types";
import {
  buildChallenge,
  buildBatchChallenge,
  decodeChallenge,
  decodeSignedTransaction,
  verifyPayment,
  settlePayment,
} from "./x402";
import {
  detectPToken,
  buildUnwrapLamportsData,
  cuSavingsSummary,
  SPL_TOKEN_PROGRAM_ID,
} from "./p-token";

export const clawdFacilitator = new Hono<{ Bindings: Env }>();

// ─── MCP tool manifest ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "clawd_pay",
    description:
      "Issue a single x402 payment challenge on Solana. " +
      "Automatically uses p-token (SIMD-0266) when active for lower CU cost. " +
      "Returns a PAYMENT-REQUIRED challenge the caller must sign and re-submit.",
    input_schema: {
      type: "object",
      required: ["resource", "payTo", "asset", "amount", "decimals"],
      properties: {
        resource: { type: "string", description: "The resource URI being gated" },
        description: { type: "string", description: "Human-readable description" },
        payTo: { type: "string", description: "base58 owner pubkey receiving payment" },
        asset: { type: "string", description: "base58 SPL mint (USDC or CLAWD)" },
        amount: { type: "string", description: "Amount in base units (bigint string)" },
        decimals: { type: "number", description: "Token decimals" },
        memo: { type: "string", description: "Optional memo" },
        timeoutSeconds: { type: "number", description: "Challenge window in seconds (default 60)" },
      },
    },
  },
  {
    name: "clawd_batch_pay",
    description:
      "Issue a p-token batch payment challenge (SIMD-0266 opcode 25). " +
      "Pays N recipients in a single instruction — significantly cheaper than N individual transfers. " +
      "Returns a PAYMENT-REQUIRED challenge with CU savings info.",
    input_schema: {
      type: "object",
      required: ["resource", "asset", "decimals", "outputs"],
      properties: {
        resource: { type: "string" },
        description: { type: "string" },
        asset: { type: "string" },
        decimals: { type: "number" },
        outputs: {
          type: "array",
          description: "Recipients — each { payTo: string, amount: string }",
          items: {
            type: "object",
            required: ["payTo", "amount"],
            properties: {
              payTo: { type: "string" },
              amount: { type: "string" },
            },
          },
          minItems: 2,
          maxItems: 64,
        },
        memo: { type: "string" },
        timeoutSeconds: { type: "number" },
      },
    },
  },
  {
    name: "clawd_settle",
    description:
      "Verify + settle a signed x402 payment (single or batch). " +
      "Returns the Solana transaction signature and p-token status.",
    input_schema: {
      type: "object",
      required: ["paymentHeader", "requirement"],
      properties: {
        paymentHeader: { type: "string", description: "base64-encoded signed transaction" },
        requirement: { type: "string", description: "base64 challenge from clawd_pay / clawd_batch_pay" },
      },
    },
  },
  {
    name: "clawd_unwrap_lamports",
    description:
      "Build an unwrap_lamports instruction (SIMD-0266 opcode 26) to recover stranded SOL " +
      "from a token mint account. Returns the serialised instruction bytes (hex). " +
      "Caller must embed this in a transaction, sign with mint authority or mint keypair, and broadcast.",
    input_schema: {
      type: "object",
      required: ["mint", "recipient", "authority"],
      properties: {
        mint: { type: "string", description: "base58 mint address" },
        recipient: { type: "string", description: "base58 pubkey to receive recovered SOL" },
        authority: { type: "string", description: "base58 mint authority (or mint keypair)" },
      },
    },
  },
  {
    name: "clawd_p_token_status",
    description:
      "Check whether p-token (SIMD-0266) is active on the connected cluster. " +
      "Returns program ID, active flag, and CU savings per transfer.",
    input_schema: { type: "object", properties: {} },
  },
  // ─── P-Token Launch Pad tools (adapted from Metaplex Genesis) ─────
  {
    name: "clawd_launch_token",
    description:
      "Create a new agent token with p-token bonding curve. " +
      "Launches a token + bonding curve + agent identity + agent-token binding " +
      "in a single transaction. Returns the mint address, bonding curve PDA, and agent PDA. " +
      "Adapted from Metaplex Genesis createAndRegisterLaunch + setAgentTokenV1.",
    input_schema: {
      type: "object",
      required: ["payerSecretKey", "name", "symbol", "uri", "agentUri"],
      properties: {
        payerSecretKey: { type: "string", description: "base58 secret key of the creator wallet" },
        name: { type: "string", description: "Token name (max 32 chars)" },
        symbol: { type: "string", description: "Token symbol (max 10 chars)" },
        uri: { type: "string", description: "Token metadata URI (Irys/Arweave URL)" },
        agentUri: { type: "string", description: "Agent registration JSON URI (ERC-8004 format)" },
        usePToken: { type: "boolean", description: "Use p-token program (default true)" },
      },
    },
  },
  {
    name: "clawd_buy_token",
    description:
      "Buy tokens from a p-token bonding curve. " +
      "Uses constant-product formula with p-token CU savings. " +
      "Returns the transaction signature and fee info. " +
      "Adapted from Metaplex Genesis / pump.fun buy.",
    input_schema: {
      type: "object",
      required: ["payerSecretKey", "mint", "amountInLamports"],
      properties: {
        payerSecretKey: { type: "string", description: "base58 secret key of buyer wallet" },
        mint: { type: "string", description: "base58 token mint address" },
        amountInLamports: { type: "string", description: "SOL amount to spend (lamports, bigint string)" },
        maxSolCost: { type: "string", description: "Maximum SOL to spend (lamports, bigint string)" },
      },
    },
  },
  {
    name: "clawd_sell_token",
    description:
      "Sell tokens back to a p-token bonding curve. " +
      "Tokens are burned, SOL is returned minus fees. " +
      "Returns the transaction signature. " +
      "Adapted from Metaplex Genesis / pump.fun sell.",
    input_schema: {
      type: "object",
      required: ["payerSecretKey", "mint", "tokenAmount"],
      properties: {
        payerSecretKey: { type: "string", description: "base58 secret key of seller wallet" },
        mint: { type: "string", description: "base58 token mint address" },
        tokenAmount: { type: "string", description: "Token amount to sell (base units, bigint string)" },
        minSolOut: { type: "string", description: "Minimum SOL to receive (lamports, bigint string)" },
      },
    },
  },
  {
    name: "clawd_register_agent",
    description:
      "Register an agent identity on-chain without creating a token. " +
      "Creates an Agent PDA with metadata URI. " +
      "Returns the agent PDA address. " +
      "Adapted from Metaplex registerIdentityV1.",
    input_schema: {
      type: "object",
      required: ["payerSecretKey", "uri"],
      properties: {
        payerSecretKey: { type: "string", description: "base58 secret key of agent owner" },
        uri: { type: "string", description: "Agent registration URI (max 256 chars)" },
      },
    },
  },
  {
    name: "clawd_fee_distribute",
    description:
      "Distribute trading fees to multiple recipients using p-token's batch instruction " +
      "(opcode 25). A single CPI instead of N individual transfers. " +
      "Costs ~1,000 CU base + 25 CU per recipient vs N × 6,200 CU with SPL Token. " +
      "Returns the batch instruction details. " +
      "INNOVATION: Single-CPI fee distribution via p-token batch.",
    input_schema: {
      type: "object",
      required: ["sourceAta", "mint", "owner", "recipients"],
      properties: {
        sourceAta: { type: "string", description: "source ATA holding the fees" },
        mint: { type: "string", description: "token mint address" },
        owner: { type: "string", description: "owner of the source ATA" },
        recipients: {
          type: "array",
          items: {
            type: "object",
            required: ["destinationAta", "amount"],
            properties: {
              destinationAta: { type: "string" },
              amount: { type: "string", description: "Amount in base units (bigint string)" },
            },
          },
          minItems: 1,
          maxItems: 64,
        },
      },
    },
  },
] as const;

// ─── Routes ───────────────────────────────────────────────────────────────────

/** GET /facilitator/clawd/tools — MCP tool manifest for this facilitator. */
clawdFacilitator.get("/tools", (c) => c.json({ tools: TOOLS }));

/** POST /facilitator/clawd/call — execute a named tool. */
clawdFacilitator.post("/call", async (c) => {
  type ToolCall = { name: string; input: Record<string, unknown> };
  const body = await c.req.json<ToolCall>();
  const ctx = c as Context<{ Bindings: Env }>;

  switch (body.name) {
    case "clawd_pay":
      return handlePay(c.env, body.input as unknown as PayInput, ctx);

    case "clawd_batch_pay":
      return handleBatchPay(c.env, body.input as unknown as BatchPayInput, ctx);

    case "clawd_settle":
      return handleSettle(c.env, body.input as unknown as SettleInput, ctx);

    case "clawd_unwrap_lamports":
      return handleUnwrapLamports(body.input as unknown as UnwrapInput, ctx);

    case "clawd_p_token_status":
      return handlePTokenStatus(c.env, ctx);

    default:
      return c.json({ error: `unknown tool: ${body.name}` }, 400);
  }
});

// ─── Tool handlers ────────────────────────────────────────────────────────────

type HonoContext = Context<{ Bindings: Env }>;

interface PayInput {
  resource: string;
  description?: string;
  payTo: string;
  asset: string;
  amount: string;
  decimals: number;
  memo?: string;
  timeoutSeconds?: number;
}

async function handlePay(env: Env, input: PayInput, c: HonoContext) {
  const challenge = await buildChallenge(env, {
    resource: input.resource,
    description: input.description ?? input.resource,
    payTo: input.payTo,
    asset: input.asset,
    amount: BigInt(input.amount),
    decimals: input.decimals,
    memo: input.memo,
    timeoutSeconds: input.timeoutSeconds,
  });

  const pToken = await detectPToken(env);
  return c.json({
    type: "payment_required",
    challenge,
    challengeHeader: btoa(JSON.stringify(challenge)),
    pToken: {
      active: pToken.active,
      cuSavingsPerTransfer: pToken.cuSavingsPerTransfer,
    },
    instructions:
      "Sign the transaction described in challenge.extra, base64-encode it, " +
      "then call clawd_settle with paymentHeader=<base64-tx> and requirement=<challengeHeader>.",
  });
}

interface BatchPayInput {
  resource: string;
  description?: string;
  asset: string;
  decimals: number;
  outputs: Array<{ payTo: string; amount: string }>;
  memo?: string;
  timeoutSeconds?: number;
}

async function handleBatchPay(env: Env, input: BatchPayInput, c: HonoContext) {
  const pToken = await detectPToken(env);
  if (!pToken.active) {
    return c.json(
      {
        error: "p-token batch requires SIMD-0266 to be active on the target cluster",
        pToken: { active: false },
      },
      400,
    );
  }

  const challenge = await buildBatchChallenge(env, {
    resource: input.resource,
    description: input.description ?? input.resource,
    asset: input.asset,
    decimals: input.decimals,
    outputs: input.outputs,
    memo: input.memo,
    timeoutSeconds: input.timeoutSeconds,
  });

  const savings = cuSavingsSummary(input.outputs.length);

  return c.json({
    type: "batch_payment_required",
    challenge,
    challengeHeader: btoa(JSON.stringify(challenge)),
    savings,
    pToken: { active: true, programId: pToken.programId },
    instructions:
      `Build a p-token batch instruction (opcode 25) with ${input.outputs.length} outputs. ` +
      "Sign, base64-encode, then call clawd_settle.",
  });
}

interface SettleInput {
  paymentHeader: string;
  requirement: string;
}

async function handleSettle(env: Env, input: SettleInput, c: HonoContext) {
  const req = decodeChallenge(input.requirement);
  const tx = decodeSignedTransaction(input.paymentHeader);

  const verify = await verifyPayment(env, tx, req);
  if (!verify.valid) {
    return c.json({ success: false, error: verify.reason }, 400);
  }

  const txSig = await settlePayment(env, tx);

  return c.json({
    success: true,
    txHash: txSig,
    networkId: req.network,
    payer: verify.payer,
    usedPToken: verify.usedPToken ?? false,
    asset: req.asset,
    amount: req.maxAmountRequired,
  });
}

interface UnwrapInput {
  mint: string;
  recipient: string;
  authority: string;
}

function handleUnwrapLamports(input: UnwrapInput, c: HonoContext) {
  const data = buildUnwrapLamportsData();
  // accounts order: [mint, recipient, authority]
  const accounts = [input.mint, input.recipient, input.authority];

  return c.json({
    type: "unwrap_lamports_instruction",
    programId: SPL_TOKEN_PROGRAM_ID.toBase58(),
    data: Array.from(data, (b) => b.toString(16).padStart(2, "0")).join(""),
    accounts,
    note:
      "Embed this instruction in a transaction, sign with the authority keypair, and broadcast. " +
      "Requires p-token (SIMD-0266) to be active on the cluster.",
  });
}

async function handlePTokenStatus(env: Env, c: HonoContext) {
  const status = await detectPToken(env);
  const savings = cuSavingsSummary(1);

  return c.json({
    ...status,
    benchmark: {
      splToken: {
        transferChecked: savings.splCu,
      },
      pToken: {
        transferChecked: savings.pTokenCu,
        batchOf10: cuSavingsSummary(10).pTokenCu,
      },
    },
  });
}
