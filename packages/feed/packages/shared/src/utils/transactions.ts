/**
 * Chain-aware confirmation depth for awaiting transaction receipts: zero on the local
 * dev chain (instant mining), one on live networks.
 */
import { getCurrentChainId } from "../config";

export function getTransactionReceiptConfirmations(
  chainId: number = getCurrentChainId(),
): number {
  return chainId === 31337 ? 0 : 1;
}
