import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import {
  type Address,
  type Chain,
  encodeFunctionData,
  getContract,
  type Hash,
  type PublicClient,
  type TestClient,
  type WalletClient,
  decodeEventLog,
  keccak256,
  stringToHex,
  encodeAbiParameters,
} from 'viem';

import { VoteAction } from '../actions/gov-vote';
import { WalletProvider } from '../providers/wallet';
import governorArtifacts from '../contracts/artifacts/OZGovernor.json';
import voteTokenArtifacts from '../contracts/artifacts/VoteToken.json';
import timelockArtifacts from '../contracts/artifacts/TimelockController.json';
import { QueueAction } from '../actions/gov-queue';
import type { Proposal } from '../types';
import { ExecuteAction } from '../actions/gov-execute';
import { ProposeAction } from '../actions/gov-propose';

export interface ProposalParams extends Proposal {
  governor?: string;
  timelock?: string;
  proposalId?: string;
}

type ContractTransaction = {
  to: Address;
  data: `0x${string}`;
};

export const buildProposal = (txs: Array<ContractTransaction>, description: string): Proposal => {
  const targets = txs.map((tx: ContractTransaction) => tx.to!);
  const values = txs.map(() => BigInt(0));
  const calldatas = txs.map((tx: ContractTransaction) => tx.data!);
  return {
    targets,
    values,
    calldatas,
    description,
  };
};

// Mock the ICacheManager
const mockCacheManager = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn(),
};

describe('Vote Action', () => {
  const alice: Address = '0xa1Ce000000000000000000000000000000000000';
  let wp: WalletProvider;
  let wc: WalletClient;
  let tc: TestClient;
  let pc: PublicClient;
  let voteTokenAddress: Address;
  let timelockAddress: Address;
  let governorAddress: Address;
  let voteToken;
  let timelock;
  let governor;

  async function getDeployedAddress(hash: `0x${string}`) {
    const receipt = await pc.waitForTransactionReceipt({
      hash,
    });
    return receipt.contractAddress;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCacheManager.get.mockResolvedValue(null);

    const pk = generatePrivateKey();
    const customChains = prepareChains();
    wp = new WalletProvider(pk, mockCacheManager as any, customChains);
    wc = wp.getWalletClient('hardhat');
    const account = wc.account;
    tc = wp.getTestClient();
    pc = wp.getPublicClient('hardhat');

    // Add this to fund the account
    await tc.setBalance({
      address: account.address,
      value: 10000000000000000000000n, // 10,000 ETH
    });

    const voteTokenDeployHash: Hash = await wc.deployContract({
      chain: customChains['hardhat'],
      account: account,
      abi: voteTokenArtifacts.abi,
      bytecode: voteTokenArtifacts.bytecode as `0x${string}`,
      args: ['Test Token', 'TEST'],
      gas: 5000000n,
    });

    const timelockDeployHash: Hash = await wc.deployContract({
      chain: customChains['hardhat'],
      account: account,
      abi: timelockArtifacts.abi,
      bytecode: timelockArtifacts.bytecode as `0x${string}`,
      args: [1, [], [], account.address],
    });

    // Get the addresses from deployment hashes
    voteTokenAddress = await getDeployedAddress(voteTokenDeployHash);
    timelockAddress = await getDeployedAddress(timelockDeployHash);

    const governorDeployHash: Hash = await wc.deployContract({
      chain: customChains['hardhat'],
      account: account,
      abi: governorArtifacts.abi,
      bytecode: governorArtifacts.bytecode as `0x${string}`,
      args: [voteTokenAddress, timelockAddress, 0, 86400, 1, 1],
    });

    governorAddress = await getDeployedAddress(governorDeployHash);

    voteToken = getContract({
      address: voteTokenAddress,
      abi: voteTokenArtifacts.abi,
      client: wc,
    });
    timelock = getContract({
      address: timelockAddress,
      abi: timelockArtifacts.abi,
      client: wc,
    });
    governor = getContract({
      address: governorAddress,
      abi: governorArtifacts.abi,
      client: wc,
    });
    const proposerRole = await timelock.read.PROPOSER_ROLE();
    await timelock.write.grantRole([proposerRole, governor.address]);
    const executorRole = await timelock.read.EXECUTOR_ROLE();
    await timelock.write.grantRole([executorRole, governor.address]);
  });
  describe('Constructor', () => {
    it('should initialize with wallet provider', () => {
      const va = new VoteAction(wp);

      expect(va).toBeDefined();
    });
  });
  describe('Vote', () => {
    let va: VoteAction;
    let proposalId: string;
    let proposal: ProposalParams;

    beforeEach(async () => {
      va = new VoteAction(wp);

      // mint 1B tokens to alice
      await voteToken.write.mint([wc.account.address, BigInt(10 ** 27)]);
      await voteToken.write.mint([timelockAddress, BigInt(10 ** 18)]);
      await voteToken.write.delegate([wc.account.address]);
      await tc.mine({
        blocks: 100,
        interval: 12, // This will advance time by 1200 seconds (12 seconds per block)
      });
      const data = encodeFunctionData({
        abi: voteTokenArtifacts.abi,
        functionName: 'transfer',
        args: [alice, BigInt(10 ** 18)],
      });
      const description = 'test proposal, transfer some token';
      proposal = buildProposal(
        [
          {
            to: voteToken.address,
            data: data,
          },
        ],
        description
      );
      const hash = await governor.write.propose([
        proposal.targets,
        proposal.values,
        proposal.calldatas,
        proposal.description,
      ]);
      const receipt = await pc.waitForTransactionReceipt({ hash });
      proposalId = getProposalId(receipt.logs);

      // Add this to move the chain forward
      await tc.mine({
        blocks: 100,
        interval: 12, // This will advance time by 1200 seconds (12 seconds per block)
      });
    });

    it('Proposes a proposal', async () => {
      const pa = new ProposeAction(wp);
      const description = 'other test proposal';
      const result = await pa.propose({
        chain: 'hardhat',
        governor: governor.address as `0x${string}`,
        targets: proposal.targets,
        values: proposal.values,
        calldatas: proposal.calldatas,
        description: description,
      });
      const pid = getProposalId(result.logs);
      const state = await governor.read.state([pid]);
      expect(state).equals(0);
    });

    it('Votes no on a proposal', async () => {
      await va.vote({
        chain: 'hardhat',
        governor: governor.address as `0x${string}`,
        proposalId: proposalId,
        support: 0,
      });

      const votes = await governor.read.proposalVotes([proposalId]);
      expect(votes[0]).equals(await voteToken.read.balanceOf([wc.account.address]));
      expect(votes[1]).equals(BigInt(0));
      expect(votes[2]).equals(BigInt(0));
    });

    it('Votes yes on a proposal', async () => {
      await va.vote({
        chain: 'hardhat',
        governor: governor.address as `0x${string}`,
        proposalId: proposalId,
        support: 1,
      });

      const votes = await governor.read.proposalVotes([proposalId]);
      expect(votes[0]).equals(BigInt(0));
      expect(votes[1]).equals(await voteToken.read.balanceOf([wc.account.address]));
      expect(votes[2]).equals(BigInt(0));
    });

    it('Abstains on a proposal', async () => {
      await va.vote({
        chain: 'hardhat',
        governor: governor.address as `0x${string}`,
        proposalId: proposalId,
        support: 2,
      });

      const votes = await governor.read.proposalVotes([proposalId]);
      expect(votes[0]).equals(BigInt(0));
      expect(votes[1]).equals(BigInt(0));
      expect(votes[2]).equals(await voteToken.read.balanceOf([wc.account.address]));
    });

    it('Queues a proposal', async () => {
      const qa = new QueueAction(wp);

      await va.vote({
        chain: 'hardhat',
        governor: governor.address as `0x${string}`,
        proposalId: proposalId,
        support: 1,
      });

      await tc.mine({
        blocks: 86400 / 12 + 1,
        interval: 12,
      });

      const state = await governor.read.state([proposalId]);

      await qa.queue({
        chain: 'hardhat',
        governor: governor.address as `0x${string}`,
        targets: proposal.targets,
        values: proposal.values,
        calldatas: proposal.calldatas,
        description: proposal.description,
      });

      const descriptionHash = keccak256(stringToHex(proposal.description));
      const salt = await governor.read.timelockSalt([descriptionHash]);
      const timelockProposalId = keccak256(
        encodeAbiParameters(
          [
            { type: 'address[]', name: 'targets' },
            { type: 'uint256[]', name: 'values' },
            { type: 'bytes[]', name: 'payloads' },
            { type: 'bytes32', name: 'predecessor' },
            { type: 'bytes32', name: 'salt' },
          ],
          [
            proposal.targets,
            proposal.values,
            proposal.calldatas,
            '0x0000000000000000000000000000000000000000000000000000000000000000',
            salt,
          ]
        )
      );
      const queued = await timelock.read.isOperationPending([timelockProposalId]);
      expect(queued).toBe(true);
    });

    it('Executes a proposal', async () => {
      const qa = new QueueAction(wp);
      const ea = new ExecuteAction(wp);

      await va.vote({
        chain: 'hardhat',
        governor: governor.address as `0x${string}`,
        proposalId: proposalId,
        support: 1,
      });

      await tc.mine({
        blocks: 86400 / 12 + 1,
        interval: 12,
      });

      const state = await governor.read.state([proposalId]);

      await qa.queue({
        chain: 'hardhat',
        governor: governor.address as `0x${string}`,
        targets: proposal.targets,
        values: proposal.values,
        calldatas: proposal.calldatas,
        description: proposal.description,
      });

      const aliceBalance = await voteToken.read.balanceOf([alice]);
      const timelockBalance = await voteToken.read.balanceOf([timelockAddress]);

      await ea.execute({
        chain: 'hardhat',
        governor: governor.address as `0x${string}`,
        proposalId: proposalId,
        targets: proposal.targets,
        values: proposal.values,
        calldatas: proposal.calldatas,
        description: proposal.description,
      });

      const aliceBalanceAfter = await voteToken.read.balanceOf([alice]);
      const timelockBalanceAfter = await voteToken.read.balanceOf([timelockAddress]);
      expect(aliceBalanceAfter).equals(aliceBalance + BigInt(10 ** 18));
      expect(timelockBalanceAfter).equals(timelockBalance - BigInt(10 ** 18));
    });
  });
});

const prepareChains = () => {
  const customChains: Record<string, Chain> = {};
  const chainNames = ['hardhat'];
  chainNames.forEach(
    (chain) =>
      (customChains[chain] = WalletProvider.genChainFromName(chain, 'http://localhost:8545'))
  );

  return customChains;
};

// Function to get proposal ID from transaction receipt
const getProposalId = (logs: any) => {
  const proposalCreatedLog = logs.find((log: any) => {
    try {
      const event = decodeEventLog({
        abi: governorArtifacts.abi,
        data: log.data,
        topics: log.topics,
      });
      return event.eventName === 'ProposalCreated';
    } catch {
      return false;
    }
  });

  if (!proposalCreatedLog) {
    throw new Error('ProposalCreated event not found in logs');
  }

  const event = decodeEventLog({
    abi: governorArtifacts.abi,
    data: proposalCreatedLog.data,
    topics: proposalCreatedLog.topics,
  });

  return event.args.proposalId;
};
