import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from '@elizaos/core';
import { ethers } from 'ethers';
import { RoflService } from '../services/rofl.ts';

const roflService = new RoflService();

export const getAgentWalletAddressProvider: Provider = {
  name: 'getAgentWalletAddressProvider',
  async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> {
    const response = await roflService.generateKey({
      key_id: runtime.agentId,
      kind: 'secp256k1',
    });

    // Use ethers to create a wallet from the private key and get the public address
    const wallet = new ethers.Wallet(response.key);

    return {
      text: wallet.address,
      data: {
        address: wallet.address,
      },
      values: {
        address: wallet.address,
      },
    };
  },
};
