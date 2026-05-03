export const AgentAccountV2Abi = [
  // ─── Owner Functions ───
  {
    name: 'setSpendPolicy',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'perTxLimit', type: 'uint256' },
      { name: 'periodLimit', type: 'uint256' },
      { name: 'periodLength', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'setOperator',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'authorized', type: 'bool' },
    ],
    outputs: [],
  },
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    name: 'approvePending',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'txId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'cancelPending',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'txId', type: 'uint256' }],
    outputs: [],
  },

  // ─── Agent Functions ───
  {
    name: 'agentExecute',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    name: 'agentTransferToken',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },

  // ─── View Functions ───
  {
    name: 'remainingBudget',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'perTx', type: 'uint256' },
      { name: 'inPeriod', type: 'uint256' },
    ],
  },
  {
    name: 'getPending',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'txId', type: 'uint256' }],
    outputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'createdAt', type: 'uint256' },
      { name: 'executed', type: 'bool' },
      { name: 'cancelled', type: 'bool' },
    ],
  },
  {
    name: 'spendPolicies',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'perTxLimit', type: 'uint256' },
      { name: 'periodLimit', type: 'uint256' },
      { name: 'periodLength', type: 'uint256' },
      { name: 'periodSpent', type: 'uint256' },
      { name: 'periodStart', type: 'uint256' },
    ],
  },
  {
    name: 'operators',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'pendingNonce',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'nonce',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // [MAX-ADDED] ABI entries for wallet health check & activity history
  {
    name: 'tokenContract',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'tokenId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'operatorEpoch',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isOperatorActive',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },

  // ─── Events ───
  {
    name: 'TransactionExecuted',
    type: 'event',
    inputs: [
      { name: 'target', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
      { name: 'data', type: 'bytes', indexed: false },
      { name: 'executor', type: 'address', indexed: true },
    ],
  },
  {
    name: 'SpendPolicyUpdated',
    type: 'event',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'perTxLimit', type: 'uint256', indexed: false },
      { name: 'periodLimit', type: 'uint256', indexed: false },
      { name: 'periodLength', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'OperatorUpdated',
    type: 'event',
    inputs: [
      { name: 'operator', type: 'address', indexed: true },
      { name: 'authorized', type: 'bool', indexed: false },
    ],
  },
  {
    name: 'TransactionQueued',
    type: 'event',
    inputs: [
      { name: 'txId', type: 'uint256', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
      { name: 'token', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'TransactionApproved',
    type: 'event',
    inputs: [{ name: 'txId', type: 'uint256', indexed: true }],
  },
  {
    name: 'TransactionCancelled',
    type: 'event',
    inputs: [{ name: 'txId', type: 'uint256', indexed: true }],
  },
] as const;

export const AgentAccountFactoryV2Abi = [
  {
    name: 'createAccount',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenContract', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [{ name: 'wallet', type: 'address' }],
  },
  {
    name: 'getAddress',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenContract', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'wallets',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenContract', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'WalletCreated',
    type: 'event',
    inputs: [
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'tokenContract', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'deployer', type: 'address', indexed: false },
    ],
  },
] as const;
