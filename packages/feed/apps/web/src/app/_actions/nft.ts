"use server";

import {
  type ConfirmResult,
  confirmMint,
  prepareMint,
  reconcileOnChainMint,
} from "@feed/api/services/nft-mint-service";
import { logger } from "@feed/shared";
import type { Hex } from "viem";
import { wrapServerActionWithSentry } from "@/lib/sentry/server-actions";

// Re-export ConfirmResult so consumers don't need to import from the service
export type { ConfirmResult };

type MintStep =
  | "auth"
  | "user_context"
  | "prepare"
  | "send_transaction"
  | "confirm";

/**
 * Result of the NFT mint action.
 * - `status: 'confirmed'`: Transaction confirmed and NFT data available
 * - `status: 'pending'`: Transaction submitted but not yet confirmed (user can check later)
 * - `status: 'error'`: An error occurred — message is safe to show in UI
 */
export type MintNftActionResult =
  | ({ status: "confirmed"; txHash: Hex } & ConfirmResult)
  | { status: "pending"; txHash: Hex; message: string }
  | {
      status: "error";
      error: string;
      step: MintStep;
      errorId: string;
      debug?: Record<string, unknown>;
    };

// Suppress unused import warnings — kept for future re-enablement
void confirmMint;
void prepareMint;
void reconcileOnChainMint;

async function mintNftActionImpl(_input?: {
  userJwt?: string;
}): Promise<MintNftActionResult> {
  const errorId = crypto.randomUUID();
  logger.warn(
    "NFT mint attempted while NFT features are disabled",
    { errorId },
    "mintNftAction",
  );
  return {
    status: "error",
    error: "NFT features are currently disabled.",
    step: "auth",
    errorId,
  };
}

export const mintNftAction = wrapServerActionWithSentry(
  "mintNftAction",
  mintNftActionImpl,
);
