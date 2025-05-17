import { type Action, logger, type IAgentRuntime } from '@elizaos/core';
import { z } from 'zod';
import { formatUnits } from '../utils/formatters.js';
import { GovernanceService } from '../services/GovernanceService.js';
import { type Address } from '../types.js';

/**
 * Action to get governance information from Polygon
 */
export const getGovernanceInfoAction: Action = {
  name: 'GET_GOVERNANCE_INFO',
  description: 'Gets governance information from Polygon, including token details and governance settings.',
  
  // Define examples
  examples: [
    "What is the current governance information on Polygon?",
    "Show me the governance token details and settings",
    "Get the governance parameters for Polygon"
  ],
  
  // Validation function
  validate: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Check if governance contract addresses are set
      const governorAddress = runtime.getSetting('GOVERNOR_ADDRESS');
      if (!governorAddress) {
        return 'GOVERNOR_ADDRESS setting is required to get governance information';
      }
      
      return true;
    } catch (error) {
      logger.error('Validation error:', error);
      return 'Invalid governance options';
    }
  },
  
  execute: async (options: any, runtime: IAgentRuntime) => {
    try {
      logger.info('Getting governance information from Polygon');
      
      // Get the governance service
      const governanceService = runtime.getService(GovernanceService.serviceType) as GovernanceService;
      if (!governanceService) {
        throw new Error('GovernanceService not available');
      }
      
      // Get token info
      logger.info('Fetching governance token information');
      const tokenInfo = await governanceService.getTokenInfo();
      
      // Get governance settings
      logger.info('Fetching governance settings');
      const governanceSettings = await governanceService.getGovernanceSettings();
      
      // Format values for readability
      const formattedSettings = {
        votingDelay: Number(governanceSettings.votingDelay),
        votingPeriod: Number(governanceSettings.votingPeriod),
        proposalThreshold: formatUnits(governanceSettings.proposalThreshold, tokenInfo.decimals),
        quorum: formatUnits(governanceSettings.quorum, tokenInfo.decimals),
      };
      
      // Format token info
      const formattedTokenInfo = {
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
        totalSupply: formatUnits(tokenInfo.totalSupply, tokenInfo.decimals),
      };
      
      logger.info(`Governance token: ${formattedTokenInfo.name} (${formattedTokenInfo.symbol})`);
      logger.info(`Total supply: ${formattedTokenInfo.totalSupply} ${formattedTokenInfo.symbol}`);
      logger.info(`Voting delay: ${formattedSettings.votingDelay} blocks`);
      logger.info(`Voting period: ${formattedSettings.votingPeriod} blocks`);
      
      return {
        actions: ['GET_GOVERNANCE_INFO'],
        data: {
          token: formattedTokenInfo,
          governance: formattedSettings
        }
      };
    } catch (error) {
      logger.error('Error getting governance information:', error);
      return {
        actions: ['GET_GOVERNANCE_INFO'],
        data: { error: error instanceof Error ? error.message : String(error) }
      };
    }
  },
};

/**
 * Action to get voting power for an address
 */
export const getVotingPowerAction: Action = {
  name: 'GET_VOTING_POWER',
  description: 'Gets voting power for an address on Polygon governance.',
  
  // Define examples
  examples: [
    "What is my voting power on Polygon governance?",
    "Show me the voting power for address 0x1234567890abcdef1234567890abcdef12345678",
    "How many votes does 0x1234567890abcdef1234567890abcdef12345678 have?"
  ],
  
  // Validation function
  validate: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Check if governance contract addresses are set
      const governorAddress = runtime.getSetting('GOVERNOR_ADDRESS');
      if (!governorAddress) {
        return 'GOVERNOR_ADDRESS setting is required to get voting power';
      }
      
      // Check if address is provided and valid
      if (!options?.address) {
        // If no address provided, check if we have a default address
        const defaultAddress = runtime.getSetting('DEFAULT_ADDRESS');
        if (!defaultAddress) {
          return 'Address is required to get voting power';
        }
      }
      
      // If address is provided, validate format
      if (options?.address) {
        const address = options.address as string;
        if (typeof address !== 'string' || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
          return 'Invalid address format';
        }
      }
      
      return true;
    } catch (error) {
      logger.error('Validation error:', error);
      return 'Invalid voting power options';
    }
  },
  
  execute: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Get address from options or default
      let address = options?.address as Address;
      if (!address) {
        address = runtime.getSetting('DEFAULT_ADDRESS') as Address;
        logger.info(`Using default address: ${address}`);
      } else {
        logger.info(`Getting voting power for address: ${address}`);
      }
      
      // Get the governance service
      const governanceService = runtime.getService(GovernanceService.serviceType) as GovernanceService;
      if (!governanceService) {
        throw new Error('GovernanceService not available');
      }
      
      // Get token info for decimals
      logger.info('Fetching governance token information');
      const tokenInfo = await governanceService.getTokenInfo();
      
      // Get voting power and token balance
      logger.info(`Fetching voting power for ${address}`);
      const [votingPower, tokenBalance] = await Promise.all([
        governanceService.getVotingPower(address),
        governanceService.getTokenBalance(address)
      ]);
      
      // Format values
      const formattedVotingPower = formatUnits(votingPower, tokenInfo.decimals);
      const formattedTokenBalance = formatUnits(tokenBalance, tokenInfo.decimals);
      
      logger.info(`Voting power: ${formattedVotingPower} votes`);
      logger.info(`Token balance: ${formattedTokenBalance} ${tokenInfo.symbol}`);
      
      return {
        actions: ['GET_VOTING_POWER'],
        data: {
          address,
          votingPower: formattedVotingPower,
          tokenBalance: formattedTokenBalance,
          symbol: tokenInfo.symbol
        }
      };
    } catch (error) {
      logger.error('Error getting voting power:', error);
      return {
        actions: ['GET_VOTING_POWER'],
        data: { error: error instanceof Error ? error.message : String(error) }
      };
    }
  },
}; 