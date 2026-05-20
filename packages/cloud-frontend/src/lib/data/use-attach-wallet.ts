/**
 * useAttachWallet — drive the SIWE flow that attaches an EVM wallet to the
 * currently-authenticated user's account.
 *
 * WHY: OAuth signups (Google / Discord / GitHub / Magic Link / Passkey) never
 * receive a `wallet_address`. The direct-crypto-payments endpoint requires
 * one, so the BSC promo (and any other wallet-native payment surface) is a
 * dead-end for OAuth users until they verify a wallet against their account.
 *
 * Flow:
 *   1. `GET /api/auth/siwe/nonce?chainId=<n>` — reuses the existing nonce
 *      store; the server consumes it in step 3.
 *   2. Build a SIWE message via `viem/siwe`, sign it with wagmi.
 *   3. `POST /api/users/me/wallet/attach` with `{ message, signature }`.
 *   4. Invalidate the user-profile query so consumers see `wallet_address`.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createSiweMessage } from "viem/siwe";
import { useAccount, useSignMessage } from "wagmi";
import { ApiError, api } from "@/lib/api-client";

interface SiweNonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  version: string;
  statement: string;
}

interface AttachWalletResponse {
  address: `0x${string}`;
  user: {
    id: string;
    wallet_address: string | null;
    wallet_chain_type: string | null;
    wallet_verified: boolean;
  };
}

export class AttachWalletError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "wallet_not_connected"
      | "wallet_taken"
      | "already_attached"
      | "signature_rejected"
      | "siwe_failed"
      | "unknown",
  ) {
    super(message);
    this.name = "AttachWalletError";
  }
}

function mapApiError(error: unknown): AttachWalletError {
  if (error instanceof ApiError) {
    const body = error.body as { code?: string } | null | undefined;
    const code = body?.code;
    if (code === "wallet_taken") {
      return new AttachWalletError(error.message, "wallet_taken");
    }
    if (code === "already_attached") {
      return new AttachWalletError(error.message, "already_attached");
    }
    if (error.status === 401) {
      return new AttachWalletError(error.message, "siwe_failed");
    }
    return new AttachWalletError(error.message, "unknown");
  }
  if (error instanceof Error) {
    if (
      error.message.toLowerCase().includes("user rejected") ||
      error.message.toLowerCase().includes("user denied")
    ) {
      return new AttachWalletError(
        "Wallet signature was rejected",
        "signature_rejected",
      );
    }
    return new AttachWalletError(error.message, "unknown");
  }
  return new AttachWalletError("Failed to attach wallet", "unknown");
}

interface UseAttachWalletOptions {
  /**
   * Chain ID to embed in the SIWE message. Defaults to BSC (56) since this
   * hook was introduced for the BSC promo flow, but the server validates the
   * signature against the address regardless of chain ID.
   */
  chainId?: number;
}

export function useAttachWallet(options: UseAttachWalletOptions = {}) {
  const chainId = options.chainId ?? 56;
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();

  return useMutation<AttachWalletResponse, AttachWalletError>({
    mutationFn: async () => {
      if (!isConnected || !address) {
        throw new AttachWalletError(
          "Connect an EVM wallet first",
          "wallet_not_connected",
        );
      }

      let nonceResp: SiweNonceResponse;
      try {
        nonceResp = await api<SiweNonceResponse>(
          `/api/auth/siwe/nonce?chainId=${chainId}`,
        );
      } catch (error) {
        throw mapApiError(error);
      }

      const message = createSiweMessage({
        address,
        domain: nonceResp.domain,
        uri: nonceResp.uri,
        version: nonceResp.version as "1",
        chainId,
        nonce: nonceResp.nonce,
        statement: nonceResp.statement,
        issuedAt: new Date(),
      });

      let signature: `0x${string}`;
      try {
        signature = await signMessageAsync({ message });
      } catch (error) {
        throw mapApiError(error);
      }

      try {
        const result = await api<AttachWalletResponse>(
          "/api/users/me/wallet/attach",
          { method: "POST", json: { message, signature } },
        );
        return result;
      } catch (error) {
        throw mapApiError(error);
      }
    },
    onSuccess: () => {
      // The user-profile query is keyed by session.user?.id; clearing the
      // family is the cheapest way to ensure the freshly-attached wallet
      // appears for every consumer.
      queryClient.invalidateQueries({ queryKey: ["user-profile"] });
    },
  });
}
