import { getCurrentChainId } from '../config';

export function getTransactionReceiptConfirmations(
  chainId: number = getCurrentChainId()
): number {
  return chainId === 31337 ? 0 : 1;
}
