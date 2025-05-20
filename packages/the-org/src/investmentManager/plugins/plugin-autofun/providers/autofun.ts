import type { Action, IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { addHeader, composeActionExamples, formatActionNames, formatActions } from '@elizaos/core';
import type { IToken } from '../types';

/**
 * Provider for CMC latest coins
 *
 * @typedef {import('./Provider').Provider} Provider
 * @typedef {import('./Runtime').IAgentRuntime} IAgentRuntime
 * @typedef {import('./Memory').Memory} Memory
 * @typedef {import('./State').State} State
 * @typedef {import('./Action').Action} Action
 *
 * @type {Provider}
 * @property {string} name - The name of the provider
 * @property {string} description - Description of the provider
 * @property {number} position - The position of the provider
 * @property {Function} get - Asynchronous function to get actions that validate for a given message
 *
 * @param {IAgentRuntime} runtime - The agent runtime
 * @param {Memory} message - The message memory
 * @param {State} state - The state of the agent
 * @returns {Object} Object containing data, values, and text related to actions
 */
export const autofunProvider: Provider = {
  name: 'AUTOFUN_INFORMATION',
  description: "Autofun latest information about the cryptocurrencies on it's platform",
  dynamic: true,
  //position: -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Get all sentiments

    const url =
      'https://api.auto.fun/api/tokens?limit=200&page=1&sortBy=createdAt&sortOrder=desc&hideImported=1';
    const res = await fetch(url);
    const tokens = await res.json();

    /*
      id: "9k4Kwf1c3n4Zw4cPr3Jb3vBb7XwfH58QkQQ3eDrHirat",
      name: "PhettaRat",
      ticker: "PHRT",
      url: "https://api.auto.fun/api/metadata/phrt_1745871795589_metadata.json",
      image: "https://storage.auto.fun/token-images/phrt_1745871795024.png",
      twitter: "https://x.com/em0tionull",
      telegram: null,
      website: "https://emotionull.art/",
      discord: null,
      farcaster: null,
      description: "A trippy purple rat, alter ego of artist Emotionull, embodies the Phettaverse – a journey from dark times to vibrant self-expression through art.  Limited edition collectible.",
      mint: "9k4Kwf1c3n4Zw4cPr3Jb3vBb7XwfH58QkQQ3eDrHirat",
      creator: "BgfkEvAQ82KHA3py5xHQpHgUjhs56zHRE5qfh1VzKGAH",
      nftMinted: null,
      lockId: null,
      lockedAmount: null,
      lockedAt: null,
      harvestedAt: null,
      status: "active",
      createdAt: "2025-04-28T20:23:50.565Z",
      lastUpdated: "2025-04-28T20:24:59.209Z",
      completedAt: null,
      withdrawnAt: null,
      migratedAt: null,
      marketId: null,
      baseVault: null,
      quoteVault: null,
      withdrawnAmount: null,
      reserveAmount: 996476800000000,
      reserveLamport: 28099000000,
      virtualReserves: 28000000000,
      liquidity: 7586.73,
      currentPrice: 2.819835e-8,
      marketCapUSD: 3806.7773,
      tokenPriceUSD: 0.0000038067772,
      solPriceUSD: 135,
      curveProgress: 0.11647059,
      curveLimit: 113000000000,
      priceChange24h: 0,
      price24hAgo: 0.0000038067772,
      volume24h: 26.82451,
      inferenceCount: 0,
      lastVolumeReset: null,
      lastPriceUpdate: null,
      holderCount: 2,
      txId: "QRFTokCmSoZf636M9RgmKSkNN9Gnat1qCPhmcqt68eYUDHLiEaWRkG28banYvqZbrpovm4QRUuYmjr3oZJmrrTy",
      migration: null,
      withdrawnAmounts: null,
      poolInfo: null,
      lockLpTxId: null,
      imported: 0,
      featured: 0,
      verified: 0,
      hidden: 0,
      is_token_2022: 0,
      hide_from_featured: 0,
      tokenSupply: "1000000000000000",
      tokenSupplyUiAmount: 1000000000,
      tokenDecimals: 6,
      lastSupplyUpdate: "2025-04-28T20:23:50.565Z",
*/

    console.log('autofun data', tokens.length);

    // get holders

    let latestTxt =
      '\nCurrent Auto.fun list of all active cryptocurrencies with latest market data:\n';
    let idx = 1;
    const fields = [
      'id',
      'name',
      'ticker',
      'url',
      'twitter',
      'telegram',
      'discord',
      'farcaster',
      'description',
      'liquidity',
      'currentPrice',
      'tokenSupplyUiAmount',
      'holderCount',
      'volume24h',
      'price24hAgo',
      'priceChange24h',
      'curveProgress',
    ];
    const remaps = {
      ticker: 'symbol',
    };
    latestTxt +=
      'id, name, symbol, url, twitter, telegram, discord, farcaster, description, liquidity, currentPrice, tokenSupplyUiAmount, holderCount, volume24h, price24hAgo, priceChange24h, curveProgress';
    for (const t of tokens) {
      const out = [];
      for (const f of fields) {
        out.push(t[f]);
      }
      latestTxt += out.join(', ') + '\n';
    }

    //console.log('intel:provider - autofun token text', latestTxt)

    const data = {
      tokens,
    };

    const values = {};

    // Combine all text sections
    const text = latestTxt + '\n';

    return {
      data,
      values,
      text,
    };
    return false;
  },
};
