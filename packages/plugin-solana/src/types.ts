import type { PublicKey } from '@solana/web3.js';

/**
 * Interface representing an item with specific properties.
 * @typedef {Object} Item
 * @property {string} name - The name of the item.
 * @property {string} address - The address of the item.
 * @property {string} symbol - The symbol of the item.
 * @property {number} decimals - The number of decimals for the item.
 * @property {string} balance - The balance of the item.
 * @property {string} uiAmount - The UI amount of the item.
 * @property {string} priceUsd - The price of the item in USD.
 * @property {string} valueUsd - The value of the item in USD.
 * @property {string} [valueSol] - Optional value of the item in SOL.
 */
export interface Item {
  name: string;
  address: string;
  symbol: string;
  decimals: number;
  balance: string;
  uiAmount: string;
  priceUsd: string;
  valueUsd: string;
  valueSol?: string;
}

/**
 * Defines the interface for storing price information for various cryptocurrencies.
 *
 * @interface Prices
 * @property {Object} solana - Price information for Solana cryptocurrency.
 * @property {string} solana.usd - Price of Solana in USD.
 * @property {Object} bitcoin - Price information for Bitcoin cryptocurrency.
 * @property {string} bitcoin.usd - Price of Bitcoin in USD.
 * @property {Object} ethereum - Price information for Ethereum cryptocurrency.
 * @property {string} ethereum.usd - Price of Ethereum in USD.
 */
export interface Prices {
  solana: { usd: string };
  bitcoin: { usd: string };
  ethereum: { usd: string };
}

/**
 * Interface representing a wallet portfolio.
 * @typedef {Object} WalletPortfolio
 * @property {string} totalUsd - The total value in USD.
 * @property {string} [totalSol] - The total value in SOL (optional).
 * @property {Array<Item>} items - An array of items in the wallet portfolio.
 * @property {Prices} [prices] - Optional prices of the items.
 * @property {number} [lastUpdated] - Timestamp of when the portfolio was last updated (optional).
 */
export interface WalletPortfolio {
  totalUsd: string;
  totalSol?: string;
  items: Array<Item>;
  prices?: Prices;
  lastUpdated?: number;
}

/**
 * Represents the structure of a Token Account Info object.
 * @typedef {object} TokenAccountInfo
 * @property {PublicKey} pubkey - The public key associated with the token account.
 * @property {object} account - Information about the token account.
 * @property {number} account.lamports - The amount of lamports in the account.
 * @property {object} account.data - Data associated with the account.
 * @property {object} account.data.parsed - Parsed information.
 * @property {object} account.data.parsed.info - Detailed information.
 * @property {string} account.data.parsed.info.mint - The mint associated with the token.
 * @property {string} account.data.parsed.info.owner - The owner of the token.
 * @property {object} account.data.parsed.info.tokenAmount - Token amount details.
 * @property {string} account.data.parsed.info.tokenAmount.amount - The amount of the token.
 * @property {number} account.data.parsed.info.tokenAmount.decimals - The decimals of the token.
 * @property {number} account.data.parsed.info.tokenAmount.uiAmount - The UI amount of the token.
 * @property {string} account.data.parsed.type - The type of parsed data.
 * @property {string} account.data.program - The program associated with the account.
 * @property {number} account.data.space - The space available in the account.
 * @property {string} account.owner - The owner of the account.
 * @property {boolean} account.executable - Indicates if the account is executable.
 * @property {number} account.rentEpoch - The rent epoch of the account.
 */
export interface TokenAccountInfo {
  pubkey: PublicKey;
  account: {
    lamports: number;
    data: {
      parsed: {
        info: {
          mint: string;
          owner: string;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number;
          };
        };
        type: string;
      };
      program: string;
      space: number;
    };
    owner: string;
    executable: boolean;
    rentEpoch: number;
  };
}
