import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import WebSocket from 'ws';

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

export class HeliusWebSocket {
  private ws: WebSocket | null = null;
  private subscriptions: Map<string, number> = new Map();
  private pingInterval: NodeJS.Timer | null = null;

  constructor(
    private apiKey: string,
    private runtime: IAgentRuntime
  ) {}

  /**
   * Connects to Helius WebSocket and sets up event handlers
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`);

        this.ws.on('open', () => {
          console.log('Helius WebSocket connected');
          this.startPing();
          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            console.log('Received message:', message);
            // Handle different message types here
          } catch (e) {
            console.error('Failed to parse WebSocket message:', e);
          }
        });

        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error);
        });

        this.ws.on('close', () => {
          console.log('WebSocket closed');
          this.cleanup();
          // Implement reconnection logic here if needed
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Subscribes to account changes for a given wallet address
   */
  async subscribeToWallet(walletAddress: string): Promise<number | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const request = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'accountSubscribe',
      params: [
        walletAddress,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
        },
      ],
    };

    return new Promise((resolve, reject) => {
      this.ws!.send(JSON.stringify(request), (error) => {
        if (error) {
          reject(error);
          return;
        }

        // Handle subscription response in message handler
        this.ws!.once('message', (data) => {
          try {
            const response = JSON.parse(data.toString());
            if (response.error) {
              reject(new Error(response.error.message));
              return;
            }

            const subscriptionId = response.result;
            this.subscriptions.set(walletAddress, subscriptionId);
            resolve(subscriptionId);
          } catch (e) {
            reject(e);
          }
        });
      });
    });
  }

  /**
   * Unsubscribes from a wallet's updates
   */
  async unsubscribeFromWallet(walletAddress: string): Promise<boolean> {
    const subscriptionId = this.subscriptions.get(walletAddress);
    if (!subscriptionId) {
      return false;
    }

    const request = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'unsubscribe',
      params: [subscriptionId],
    };

    return new Promise((resolve, reject) => {
      this.ws!.send(JSON.stringify(request), (error) => {
        if (error) {
          reject(error);
          return;
        }
        this.subscriptions.delete(walletAddress);
        resolve(true);
      });
    });
  }

  /**
   * Starts the ping interval to keep connection alive
   */
  private startPing() {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Cleans up resources
   */
  private cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.subscriptions.clear();
  }

  /**
   * Closes the WebSocket connection
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.cleanup();
    }
  }
}

export const heliusProvider: Provider = {
  name: 'HELIUS_INFORMATION',
  description: 'Helius latest information about the cryptocurrencies using Laserstream',
  dynamic: true,

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const laserstream = new HeliusWebSocket(runtime.getSetting('HELIUS_API_KEY'), runtime);

    // Example subscription to token program
    const request: SubscribeRequest = {
      transactions: {
        client: {
          accountInclude: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], // Token program
          accountExclude: [],
          accountRequired: [],
          vote: false,
          failed: false,
        },
      },
      commitment: CommitmentLevel.CONFIRMED,
      accounts: {},
      slots: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
    };

    try {
      // Get token data from Helius API
      const url = `https://api.helius.xyz/v0/token-metadata?api-key=${runtime.getSetting('HELIUS_API_KEY')}`;
      const response = await fetch(url);
      const tokens = await response.json();

      // Process token data
      const data = {
        tokens: tokens.map((token: any) => ({
          symbol: token.symbol || 'Unknown',
          name: token.name || 'Unknown',
          address: token.address,
          decimals: token.decimals,
          totalSupply: token.totalSupply,
          marketCap: token.marketCap,
          volume24h: token.volume24h,
          price: token.price,
        })),
      };

      // Format text response
      let text = '\nCurrent Helius token information:\n\n';
      data.tokens.forEach((token: any) => {
        text += `${token.name} (${token.symbol})\n`;
        text += `Address: ${token.address}\n`;
        text += `Price: $${token.price}\n`;
        text += `24h Volume: $${token.volume24h}\n`;
        text += `Market Cap: $${token.marketCap}\n\n`;
      });

      return {
        data,
        values: {},
        text,
      };
    } catch (error) {
      console.error('Error in Helius provider:', error);
      throw error;
    }
  },
};
