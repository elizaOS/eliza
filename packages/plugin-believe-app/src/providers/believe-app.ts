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
export const believeAppProvider: Provider = {
  name: 'BELIEVE_APP_INFORMATION',
  description: 'Belive.app latest information about the cryptocurrencies',
  dynamic: true,
  //position: -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Get all sentiments

    const url = 'https://believe.xultra.fun/api/coins?after_id=0';
    const res = await fetch(url);
    const tokens = await res.json();

    /*
     "id": 1330,
      "address": "CaTpcYihMvghkqdmV4SziVFpujQKK7A1ii21iHeWL1Qo",
      "name": "test",
      "symbol": "TEST",
      "uri": "https://ipfs.io/ipfs/bafkreigbllwsoq7j63k4v6wodpvyvwkqfdbqvbalspxgui3q4xvm3ry224",
      "description": "@launchcoin  $test + test",
      "imageUrl": "https://ipfs.io/ipfs/bafkreiewzql54dalga23ncsxcnat4cholwujkwc326f2cuvrclo6ruxrp4",
      "onChainCreatedAt": "1747345370",
      "fetchedAt": "1747345375",
      "transactionSignature": "3z2ViXX8dvPs7TY1oSsDzE3ePQbfJEGmtBFPE1wd4h6wmLnT3Qi7Q77RKcKFawhzJqAsdgxyVRaSZg1PeLuzBvtj",
      "metadata": {
        "id": 1298,
        "tokenId": 1330,
        "creatorId": 1298,
        "mentionId": "8ddbceb5-cc91-41f9-b565-6e040a929ca5",
        "tweetId": "1923131784104989020",
        "twitterConversationId": "1923131784104989020",
        "tweetCreatorUserId": "1784539335385133056",
        "tweetReplyAuthorId": "1784539335385133056",
        "createdAt": "1747345375",
        "creator": {
          "id": 1298,
          "twitterUsername": "lemsentt",
          "followersCount": 164,
          "smartFollowersCount": 3,
          "profileImageUrl": "https://pbs.twimg.com/profile_images/1880241524425834496/0-INnrjb_normal.jpg",
          "lastUpdatedAt": "1747345375"
        }
      }
*/

    console.log('believe.app data', tokens);

    // get holders

    let latestTxt =
      '\nCurrent believe.app list of all active cryptocurrencies with latest market data:\n';
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
