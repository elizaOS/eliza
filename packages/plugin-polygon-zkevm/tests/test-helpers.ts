import { vi } from 'vitest';
import type { IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';

/**
 * Creates a mock message for testing zkEVM actions
 */
export function createMockMessage(text: string, source = 'test'): Memory {
  return {
    id: 'test-message-id',
    userId: 'test-user-id',
    agentId: 'test-agent-id',
    roomId: 'test-room-id',
    content: {
      text,
      source,
    },
    createdAt: Date.now(),
    embedding: new Array(1536).fill(0),
  };
}

/**
 * Creates a mock state for testing
 */
export function createMockState(): State {
  return {
    userId: 'test-user-id',
    agentId: 'test-agent-id',
    roomId: 'test-room-id',
    bio: 'Test bio',
    lore: 'Test lore',
    messageDirections: 'Test directions',
    postDirections: 'Test post directions',
    actors: 'Test actors',
    goals: 'Test goals',
    recentMessages: 'Test recent messages',
    recentMessagesData: [],
    actionNames: 'Test action names',
    actions: 'Test actions',
    providers: 'Test providers',
    responseData: 'Test response data',
    recentInteractionsData: [],
    recentInteractions: 'Test recent interactions',
    formattedConversation: 'Test formatted conversation',
    knowledge: 'Test knowledge',
    knowledgeData: [],
  };
}

/**
 * Creates a mock callback for testing
 */
export function createMockCallback(): HandlerCallback {
  return vi.fn();
}

/**
 * Creates a mock runtime with zkEVM configuration
 */
export function createMockRuntime(
  config: Partial<{
    ALCHEMY_API_KEY: string;
    ZKEVM_RPC_URL: string;
    PRIVATE_KEY: string;
  }> = {}
): IAgentRuntime {
  const defaultConfig = {
    ALCHEMY_API_KEY: 'test-alchemy-key',
    ZKEVM_RPC_URL: 'https://test-zkevm-rpc.com',
    PRIVATE_KEY: 'test-private-key',
    ...config,
  };

  return {
    getSetting: vi.fn((key: string) => defaultConfig[key as keyof typeof defaultConfig]),
    character: {
      name: 'Test Agent',
      bio: 'Test bio',
      lore: 'Test lore',
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      clients: [],
      plugins: [],
      settings: {
        secrets: {},
        voice: {
          model: 'test',
        },
      },
    },
    databaseAdapter: {
      db: null,
    },
    token: 'test-token',
    modelProvider: 'test-provider',
    imageModelProvider: 'test-image-provider',
    fetch: vi.fn(),
    booleanProvider: vi.fn(),
    providers: new Map(),
    actions: new Map(),
    evaluators: new Map(),
    services: new Map(),
    memoryManagers: new Map(),
    cacheManager: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    },
    agentId: 'test-agent-id',
    serverUrl: 'http://localhost:3000',
    getConversationLength: vi.fn(),
    processActions: vi.fn(),
    evaluate: vi.fn(),
    ensureConnection: vi.fn(),
    ensureParticipantExists: vi.fn(),
    ensureUserExists: vi.fn(),
    ensureParticipantInRoom: vi.fn(),
    ensureRoomExists: vi.fn(),
    composeState: vi.fn(),
    updateRecentMessageState: vi.fn(),
    compose: vi.fn(),
    getService: vi.fn(),
    registerAction: vi.fn(),
    registerEvaluator: vi.fn(),
    registerProvider: vi.fn(),
    registerMemoryManager: vi.fn(),
    getMemoryManager: vi.fn(),
    getProvider: vi.fn(),
    getActions: vi.fn(),
    getEvaluators: vi.fn(),
    getActors: vi.fn(),
    processGoalsForRoom: vi.fn(),
  } as unknown as IAgentRuntime;
}

/**
 * Creates mock zkEVM block data
 */
export function createMockBlockData(blockNumber: number = 22628395) {
  return {
    number: blockNumber,
    hash: '0x39c52556d3bde3836aadaba82bfefc9cb445f1ee86a99ff7f4aa030b80a1cc49',
    timestamp: Math.floor(Date.now() / 1000),
    gasLimit: '30000000',
    gasUsed: '15000000',
    transactions: [
      '0x06556a9b5a8e87d0d65f545091e1c417963f46052771fe7004fa5aa1e5aa75b1',
      '0x37dd449b03692bc97177876c34c2a263fa57079e271183a564bcf6370d6916d4',
    ],
  };
}

/**
 * Creates mock transaction data
 */
export function createMockTransactionData(
  hash: string = '0x06556a9b5a8e87d0d65f545091e1c417963f46052771fe7004fa5aa1e5aa75b1'
) {
  return {
    hash,
    from: '0xA214AED7Cf1982D5e342Fd93711a49153623f953',
    to: '0xb3314456567986e657d4C65Ec9e8cB736B92d11D',
    value: '0',
    gasLimit: '151533',
    gasPrice: '19800000',
    nonce: 6643,
    blockNumber: 22628255,
    blockHash: '0x82ea4e3c4e5139b7193630661079407bed719c14135889289be6dfe7056fe4d9',
  };
}

/**
 * Creates mock transaction receipt
 */
export function createMockTransactionReceipt(
  hash: string = '0x06556a9b5a8e87d0d65f545091e1c417963f46052771fe7004fa5aa1e5aa75b1'
) {
  return {
    transactionHash: hash,
    status: 1,
    gasUsed: '100856',
    logs: [
      {
        address: '0x1cadcd88fc148d3966ede75d029937c886f66009',
        topics: ['0xb2f6c1f8eb5fbd0c54cd0ffc1e20678d7e991cb8aed8471c1252cdc7d64549be'],
        data: '0x0000000000000000000000000000000000000000000000000000000000000001',
      },
    ],
  };
}

/**
 * Creates mock batch data
 */
export function createMockBatchData(batchNumber: number = 12345) {
  return {
    batchNumber,
    timestamp: '2023-05-14T22:00:44.000Z',
    coinbase: '0x148ee7daf16574cd020afa34cc658f8f3fbd2800',
    stateRoot: '0x708084a8799b8621dbe676b920d8a8083665b917fb52e86b921b24928995e4d7',
    globalExitRoot: '0x65d237377f3c1853fe117d00fea55f76d89adda8a73489d33437baa8306ad2e2',
    transactions: [
      '0xb8822805bd7e2144e28848b9c28343b957f8021b78613a9ada9ba1685e3fde3f',
      '0xfb603a3026ef34cce38de19d04f50432fa45985a9d6e97c5fbfa6fea8f479939',
    ],
    verifyBatchTxHash: '0xea24be1fdbb9d953705a074149e3de77707462d06a441855953ebb0f18abc068',
  };
}

/**
 * Resets all common mocks
 */
export function resetCommonMocks() {
  vi.clearAllMocks();
}

/**
 * Creates mock Alchemy provider responses
 */
export function createMockAlchemyResponses() {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(22628395),
    getBalance: vi.fn().mockResolvedValue('199996706426001177549345550'),
    getGasPrice: vi.fn().mockResolvedValue('19800000'),
    getTransaction: vi.fn().mockResolvedValue(createMockTransactionData()),
    getTransactionReceipt: vi.fn().mockResolvedValue(createMockTransactionReceipt()),
    getCode: vi.fn().mockResolvedValue('0x60806040526004361061005e5760003560e01c80'),
    send: vi.fn().mockImplementation((method: string, params: any[]) => {
      switch (method) {
        case 'eth_getLogs':
          return Promise.resolve([
            {
              address: '0x1cadcd88fc148d3966ede75d029937c886f66009',
              blockNumber: '0x1594643',
              transactionHash: '0x06556a9b5a8e87d0d65f545091e1c417963f46052771fe7004fa5aa1e5aa75b1',
              topics: ['0xb2f6c1f8eb5fbd0c54cd0ffc1e20678d7e991cb8aed8471c1252cdc7d64549be'],
              data: '0x0000000000000000000000000000000000000000000000000000000000000001',
            },
          ]);
        case 'zk_getBatchById':
          return Promise.resolve(createMockBatchData());
        default:
          return Promise.resolve(null);
      }
    }),
  };
}
