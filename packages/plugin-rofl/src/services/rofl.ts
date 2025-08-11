import net from 'node:net';
import { logger } from '@elizaos/core';
// import { captureError } from "@elizaos/sentry";
import axios from 'axios';
import { ethers } from 'ethers';
import type { GenerateKeyPayload, GenerateKeyResponse } from '../types.ts';

const DEFAULT_SOCKET_PATH = '/run/rofl-appd.sock';

export class RoflService {
  constructor(private readonly socketPath: string = DEFAULT_SOCKET_PATH) {}

  private async checkSocketAvailability(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath, () => {
        socket.end();
        resolve(true);
      });

      socket.on('error', (error) => {
        logger.error(`ROFL socket not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  async generateKey(payload: GenerateKeyPayload): Promise<GenerateKeyResponse> {
    // Check if mock mode is enabled
    if (process.env.MOCK_ROFL_SERVICE === 'true') {
      logger.info('ROFL service mock mode enabled, returning mocked response');
      return {
        key: '2152d84b9a090d517afb0ebbfff1982b06452078159a950a34b3ae34c81f8446', // Mock private key
      } as GenerateKeyResponse;
    }

    const isSocketAvailable = await this.checkSocketAvailability();
    if (!isSocketAvailable) {
      throw new Error('ROFL socket is not available');
    }

    try {
      const response = await axios.post<GenerateKeyResponse>(
        'http://localhost/rofl/v1/keys/generate',
        payload,
        {
          socketPath: this.socketPath,
        }
      );

      return response.data;
    } catch (error) {
      logger.error(`Error generating key: ${(error as Error).message}`);
      // captureError(error as Error, {
      // 	action: "generateKey",
      // 	key_id: payload.key_id,
      // 	kind: payload.kind,
      // });
      throw error;
    }
  }

  async getAgentWallet(agentId: string): Promise<ethers.Wallet> {
    try {
      const response = await this.generateKey({
        key_id: agentId,
        kind: 'secp256k1',
      });

      // Use ethers to create a wallet from the private key and get the wallet instance
      const wallet = new ethers.Wallet(response.key);

      return wallet;
    } catch (error) {
      logger.error(`Error generating agent public address: ${(error as Error).message}`);
      // captureError(error as Error, {
      // 	action: "generateAgentPublicAddress",
      // 	agent_id: agentId,
      // });
      throw error;
    }
  }
}
