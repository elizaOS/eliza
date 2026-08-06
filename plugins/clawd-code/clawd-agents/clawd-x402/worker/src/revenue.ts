/**
 * Revenue split math and clawd-vault program client.
 *
 * After a payment settles, the gateway records the inbound amount against
 * the agent. Periodically (cron trigger), the vault's `distribute` instruction
 * is invoked to push funds out to the four recipients.
 *
 * This file owns:
 *   - computeSplit(record, amount) — pure function, no I/O
 *   - instruction builders for the Anchor program (stubs — fill in once the
 *     IDL is generated from programs/clawd-vault)
 */

import type { AgentRecord, Env, SettlementReceipt } from "./types";

export interface Split {
  owner: bigint;
  buyback: bigint;
  treasury: bigint;
  operator: bigint;
}

export function computeSplit(env: Env, record: AgentRecord, amount: bigint): Split {
  const ownerBps = record.splitOwnerBps ?? env.SPLIT_OWNER_BPS;
  const buybackBps = record.splitBuybackBps ?? env.SPLIT_BUYBACK_BPS;
  const treasuryBps = record.splitTreasuryBps ?? env.SPLIT_TREASURY_BPS;
  const operatorBps = record.splitOperatorBps ?? env.SPLIT_OPERATOR_BPS;

  const total = ownerBps + buybackBps + treasuryBps + operatorBps;
  if (total !== 10000) {
    throw new Error(`split bps must sum to 10000, got ${total}`);
  }

  // Truncate each share, then give the rounding dust to the owner.
  const owner = (amount * BigInt(ownerBps)) / 10000n;
  const buyback = (amount * BigInt(buybackBps)) / 10000n;
  const treasury = (amount * BigInt(treasuryBps)) / 10000n;
  const operator = (amount * BigInt(operatorBps)) / 10000n;
  const dust = amount - owner - buyback - treasury - operator;

  return {
    owner: owner + dust,
    buyback,
    treasury,
    operator,
  };
}

export function receipt(
  protocol: SettlementReceipt["protocol"],
  agent: string,
  caller: string,
  signature: string,
  amount: bigint,
  asset: string,
  split: Split,
  discount?: SettlementReceipt["discount"],
): SettlementReceipt {
  return {
    protocol,
    agent,
    caller,
    signature,
    amount: amount.toString(),
    asset,
    discount,
    split: {
      owner: split.owner.toString(),
      buyback: split.buyback.toString(),
      treasury: split.treasury.toString(),
      operator: split.operator.toString(),
    },
    timestamp: Date.now(),
  };
}

/**
 * Stub: call the clawd-vault Anchor program to distribute accumulated revenue
 * for a given agent. Wired up once the Anchor IDL is compiled and exported.
 *
 * Flow:
 *   1. Load OPERATOR_KEYPAIR
 *   2. Build Distribute ix with accounts:
 *        - agent_pda (writable)
 *        - treasury_ata (writable)
 *        - owner_ata (writable)
 *        - buyback_ata (writable)
 *        - operator_ata (writable)
 *        - token_program
 *   3. Sign + send via rpc.sendRawTransaction
 */
export async function distribute(_env: Env, _agentId: string): Promise<{ signature: string }> {
  throw new Error("distribute: wire the Anchor program IDL before calling");
}
