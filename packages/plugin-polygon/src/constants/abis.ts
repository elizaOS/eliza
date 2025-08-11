/**
 * This file centralizes all ABI imports for the Polygon plugin
 */

// Import full ABIs from JSON files
import ERC20ABI from '../contracts/ERC20ABI.json' with { type: "json" };
import RootChainManagerABI from '../contracts/RootChainManagerABI.json' with { type: "json" };
import StakeManagerABI from '../contracts/StakeManagerABI.json' with { type: "json" };
import ValidatorShareABI from '../contracts/ValidatorShareABI.json' with { type: "json" };
import OZGovernorABI from '../contracts/OZGovernorABI.json' with { type: "json" };
import TimelockControllerABI from '../contracts/TimelockControllerABI.json' with { type: "json" };
import VoteTokenABI from '../contracts/VoteTokenABI.json' with { type: "json" };

// Export full ABIs for contract initialization
export {
  ERC20ABI,
  RootChainManagerABI,
  StakeManagerABI,
  ValidatorShareABI,
  OZGovernorABI,
  TimelockControllerABI,
  VoteTokenABI
};

// Minimal ERC20 ABI for common token operations (used by viem)
export const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
    stateMutability: 'view'
  },
  {
    name: 'decimals',
    type: 'function',
    inputs: [],
    outputs: [{ name: 'decimals', type: 'uint8' }],
    stateMutability: 'view'
  },
  {
    name: 'symbol',
    type: 'function',
    inputs: [],
    outputs: [{ name: 'symbol', type: 'string' }],
    stateMutability: 'view'
  },
  {
    name: 'name',
    type: 'function',
    inputs: [],
    outputs: [{ name: 'name', type: 'string' }],
    stateMutability: 'view'
  }
] as const;

// Minimal StakeManager ABI for staking operations
export const STAKE_MANAGER_ABI = [
  {
    name: 'validators',
    type: 'function',
    inputs: [{ name: 'validatorId', type: 'uint256' }],
    outputs: [
      { name: 'status', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'commissionRate', type: 'uint256' },
      { name: 'signer', type: 'address' },
      { name: 'activationEpoch', type: 'uint256' },
      { name: 'deactivationEpoch', type: 'uint256' },
      { name: 'jailTime', type: 'uint256' }
    ],
    stateMutability: 'view'
  }
] as const;

// Minimal ValidatorShare ABI for delegation operations
export const VALIDATOR_SHARE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
    stateMutability: 'view'
  },
  {
    name: 'getLiquidRewards',
    type: 'function',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: 'rewards', type: 'uint256' }],
    stateMutability: 'view'
  }
] as const; 