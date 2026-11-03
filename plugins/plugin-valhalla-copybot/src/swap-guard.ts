import { LIMITS } from "./limits.ts";

export interface DecodedInstruction {
  programId: string;
  data: Uint8Array;
}

const TRANSFER = 2;
const WITHDRAW_NONCE = 5;
const TRANSFER_WITH_SEED = 11;

/**
 * Reject System Program transfers and nonce withdraws.
 * A swap may move value inside the AMM program. It must not add a SOL transfer
 * to another wallet. Unknown program indexes fail closed in the versioned-tx helper.
 */
export function assertNoValueTransfer(instructions: readonly DecodedInstruction[]): void {
  for (const ix of instructions) {
    if (ix.programId !== LIMITS.systemProgramId) continue;
    const tag = ix.data[0];
    if (tag === TRANSFER || tag === TRANSFER_WITH_SEED || tag === WITHDRAW_NONCE) {
      throw new Error(
        "Refusing a System Program transfer or withdraw. The plugin has no send path."
      );
    }
  }
}

export const FORBIDDEN_ACTION_NAMES = ["TRANSFER", "SEND", "WITHDRAW", "SWEEP", "AIRDROP"] as const;

export function isForbiddenActionName(name: string): boolean {
  const upper = name.toUpperCase();
  return FORBIDDEN_ACTION_NAMES.some((word) => upper.includes(word));
}
