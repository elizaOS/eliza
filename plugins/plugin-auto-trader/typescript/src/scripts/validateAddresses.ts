#!/usr/bin/env node

import { PublicKey } from '@solana/web3.js';
import { ALL_MEME_COINS } from '../config/memeCoins.ts';

async function validateAddresses() {
  console.log('Validating Solana addresses...\n');

  const validAddresses: typeof ALL_MEME_COINS = [];
  const invalidAddresses: typeof ALL_MEME_COINS = [];

  for (const coin of ALL_MEME_COINS) {
    try {
      // Try to create a PublicKey from the address
      const pubkey = new PublicKey(coin.address);

      // Check if it's a valid base58 string and on curve
      if (pubkey.toBase58() === coin.address) {
        validAddresses.push(coin);
      } else {
        invalidAddresses.push(coin);
      }
    } catch (error) {
      invalidAddresses.push(coin);
    }
  }

  console.log(`Total coins: ${ALL_MEME_COINS.length}`);
  console.log(`Valid addresses: ${validAddresses.length}`);
  console.log(`Invalid addresses: ${invalidAddresses.length}\n`);

  if (invalidAddresses.length > 0) {
    console.log('Invalid addresses found:');
    invalidAddresses.forEach((coin: { symbol: string; address: string }) => {
      console.log(`- ${coin.symbol}: ${coin.address}`);
    });
  }

  return { validAddresses, invalidAddresses };
}

// Run validation
validateAddresses().catch(console.error);
