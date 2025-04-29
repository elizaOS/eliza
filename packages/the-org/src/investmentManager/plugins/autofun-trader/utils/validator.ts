import { logger } from '@elizaos/core';
import { PublicKey } from '@solana/web3.js';

export function validateSolanaAddress(address: string | undefined): boolean {
  if (!address) return false;
  try {
    // Handle Base (0x) addresses
    if (address.startsWith('0x')) {
      const isValidBase = /^0x[a-fA-F0-9]{40}$/.test(address);
      logger.log(`Base address validation: ${address}`, { isValid: isValidBase });
      return isValidBase;
    }

    // Handle Solana addresses
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      logger.warn(`Invalid Solana address format: ${address}`);
      return false;
    }

    const pubKey = new PublicKey(address);
    const isValid = Boolean(pubKey.toBase58());
    logger.log(`Solana address validation: ${address}`, { isValid });
    return isValid;
  } catch (error) {
    logger.error(`Address validation error: ${address}`, { error });
    return false;
  }
}
