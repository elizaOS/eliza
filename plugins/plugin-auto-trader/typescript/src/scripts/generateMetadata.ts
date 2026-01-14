#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

const baseCacheDir = process.env.ELIZA_DATA_DIR || path.join(os.homedir(), '.eliza');
const CACHE_DIR = path.join(baseCacheDir, 'cache/auto_trader_historical_data');

// Mapping of addresses to token metadata
const TOKEN_METADATA: Record<string, { symbol: string; name: string }> = {
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: 'BONK', name: 'Bonk' },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: 'WIF', name: 'dogwifhat' },
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': { symbol: 'POPCAT', name: 'Popcat' },
  A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump: { symbol: 'FWOG', name: 'FWOG' },
  ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82: { symbol: 'BOME', name: 'BOOK OF MEME' },
  HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4: { symbol: 'MYRO', name: 'Myro' },
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU': { symbol: 'SAMO', name: 'Samoyedcoin' },
  '5z3EqYQo9HiCEs3R84RCDMu2n7anpDMxRhdK8PSWmrRC': { symbol: 'PONKE', name: 'PONKE' },
  HaP8r3ksG76PhQLTqR8FYBeNiQpejcFbQmiHbg787Ut1: { symbol: 'TRUMP', name: 'TRUMP' },
  '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump': { symbol: 'PNUT', name: 'Peanut the Squirrel' },
  CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump: { symbol: 'GOAT', name: 'Goatseus Maximus' },
  Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump: { symbol: 'CHILLGUY', name: 'Just a chill guy' },
  ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY: { symbol: 'MOODENG', name: 'moodeng' },
  WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk: { symbol: 'WEN', name: 'Wen' },
  Fch1oixTPri8zxBnmdCEADoJW2toyFHxqDZacQkwdvSP: { symbol: 'HARAMBE', name: 'Harambe' },
  CiKu4eHsVrc1eueVQeHn7qhXTcVu95gSQmBpX4utjL9z: { symbol: 'SHIB', name: 'Shiba Saga' },
  '5mbK36SZ7J19An8jFochhQS4of8g6BwUjbeCSxBSoWdp': { symbol: 'MICHI', name: 'michi' },
  '7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs': { symbol: 'SILLY', name: 'Silly Dragon' },
  '4Cnk9EPnW5ixfLZatCPJjDB1PUtcRpVVgTQukm9epump': { symbol: 'NUB', name: 'nubcat' },
  '6ogzHhzdrQr9Pgv6hZ2MNze7UrzBMAFyBBWUYp1Fhitx': { symbol: 'RETARDIO', name: 'retardio' },
  '3S8qX1MsMqRbiwKg2cQyx7nis1oHMgaCuc9c4VfvVdPN': { symbol: 'MOTHER', name: 'MOTHER IGGY' },
  '9PR7nCP9DpcUotnDPVLUBUZKu5WAYkwrCUx9wDnSpump': { symbol: 'BAN', name: 'Comedian' },
  '8x5VqbHA8D7NkD52uNuS5nnt3PwA8pLD34ymskeSo2Wn': {
    symbol: 'BERT',
    name: 'Bertram The Pomeranian',
  },
  AR1Mtgh7zAtxuxGd2XPovXPVjcSdY3i4rQYisNadjfKy: { symbol: 'SUSHI', name: 'Sushi Swap' },
};

async function generateMetadataFiles() {
  console.log('Generating metadata files for cached historical data...\n');

  try {
    // Get all files in the cache directory
    const files = await fs.readdir(CACHE_DIR);
    const historicalDataFiles = files.filter((f) => f.startsWith('historicalData_'));

    let generatedCount = 0;

    for (const file of historicalDataFiles) {
      // Extract address from filename
      // Format: historicalData_birdeye_{address}_1m_{start}_date_{end}_date.json
      const parts = file.split('_');
      const address = parts[2];

      if (TOKEN_METADATA[address]) {
        const metadata = {
          symbol: TOKEN_METADATA[address].symbol,
          name: TOKEN_METADATA[address].name,
          address: address,
          source: 'birdeye',
          lastUpdated: new Date().toISOString(),
        };

        const metadataPath = path.join(CACHE_DIR, `metadata_${address}.json`);
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

        console.log(`✓ Generated metadata for ${metadata.symbol} (${metadata.name})`);
        generatedCount++;
      } else {
        console.log(`⚠️  No metadata mapping found for address: ${address}`);
      }
    }

    console.log(`\n✅ Generated ${generatedCount} metadata files`);
  } catch (error) {
    console.error('Error generating metadata files:', error);
  }
}

// Run the script
generateMetadataFiles().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
