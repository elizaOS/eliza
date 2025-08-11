export const KEYS_FACTORY_ABI = [
  // Events
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'previousAdmin',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'newAdmin',
        type: 'address',
      },
    ],
    name: 'AdminChanged',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'beacon',
        type: 'address',
      },
    ],
    name: 'BeaconUpgraded',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'enum SharesFactory.ImplementationType',
        name: 'implementationType',
        type: 'uint8',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'implementationAddress',
        type: 'address',
      },
    ],
    name: 'DistributorImplAddressUpdated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'issuer',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'nonce',
        type: 'uint256',
      },
    ],
    name: 'NonceUsed',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'address',
        name: 'protocolFeeDestination',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'protocolFeePercent',
        type: 'uint64',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'holdersFeePercent',
        type: 'uint64',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'subjectFeePercent',
        type: 'uint64',
      },
    ],
    name: 'ProtocolFeeUpdated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'operator',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'requested',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'assigned',
        type: 'uint256',
      },
    ],
    name: 'RoleUpdated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'creator',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'contract TradeableShares',
        name: 'implementationContract',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'contract HoldersRewardsDistributor',
        name: 'holdersRewardsDistributor',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'enum SharesFactory.ImplementationType',
        name: 'implementationType',
        type: 'uint8',
      },
      {
        components: [
          {
            internalType: 'address',
            name: 'tokenAddress',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'tokenId',
            type: 'uint256',
          },
        ],
        indexed: false,
        internalType: 'struct TradeableShares.SharesSubject',
        name: 'sharesSubject',
        type: 'tuple',
      },
      {
        indexed: false,
        internalType: 'bool',
        name: 'newDeployment',
        type: 'bool',
      },
    ],
    name: 'SharesContractRegistered',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'enum SharesFactory.ImplementationType',
        name: 'implementationType',
        type: 'uint8',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'implementationAddress',
        type: 'address',
      },
    ],
    name: 'SharesImplAddressUpdated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'sharesOwnerAddress',
        type: 'address',
      },
    ],
    name: 'SharesOwnerAddressUpdated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'implementation',
        type: 'address',
      },
    ],
    name: 'Upgraded',
    type: 'event',
  },

  // Feature Constants
  {
    inputs: [],
    name: 'FEATURE_ALLOW_EXCLUSIVE_BUY',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'FEATURE_ALLOW_PAUSED_DEPLOYMENTS',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'FEATURE_SHARES_DEPLOYMENT_ENABLED',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },

  // Role Constants
  {
    inputs: [],
    name: 'ROLE_ACCESS_MANAGER',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'ROLE_FACTORY_DEPLOYMENT_MANAGER',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'ROLE_HOLDERS_FEE_MANAGER',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'ROLE_PROTOCOL_FEE_MANAGER',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'ROLE_SHARES_REGISTRAR',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'ROLE_SUBJECT_FEE_MANAGER',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'ROLE_UPGRADE_MANAGER',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },

  // Main Functions
  {
    inputs: [
      {
        internalType: 'enum SharesFactory.ImplementationType',
        name: '_implementationType',
        type: 'uint8',
      },
      {
        components: [
          {
            internalType: 'address',
            name: 'tokenAddress',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'tokenId',
            type: 'uint256',
          },
        ],
        internalType: 'struct TradeableShares.SharesSubject',
        name: '_sharesSubject',
        type: 'tuple',
      },
    ],
    name: 'deploySharesContract',
    outputs: [
      {
        internalType: 'contract TradeableShares',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'enum SharesFactory.ImplementationType',
        name: '_implementationType',
        type: 'uint8',
      },
      {
        components: [
          {
            internalType: 'address',
            name: 'tokenAddress',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'tokenId',
            type: 'uint256',
          },
        ],
        internalType: 'struct TradeableShares.SharesSubject',
        name: '_sharesSubject',
        type: 'tuple',
      },
      {
        internalType: 'uint256',
        name: '_amount',
        type: 'uint256',
      },
    ],
    name: 'deploySharesContractAndBuy',
    outputs: [
      {
        internalType: 'contract TradeableShares',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'enum SharesFactory.ImplementationType',
        name: '_implementationType',
        type: 'uint8',
      },
      {
        components: [
          {
            internalType: 'address',
            name: 'tokenAddress',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'tokenId',
            type: 'uint256',
          },
        ],
        internalType: 'struct TradeableShares.SharesSubject',
        name: '_sharesSubject',
        type: 'tuple',
      },
    ],
    name: 'deploySharesContractPaused',
    outputs: [
      {
        internalType: 'contract TradeableShares',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  // View Functions
  {
    inputs: [
      {
        internalType: 'contract TradeableShares',
        name: '_sharesContract',
        type: 'address',
      },
    ],
    name: 'determineImplementationType',
    outputs: [
      {
        internalType: 'enum SharesFactory.ImplementationType',
        name: '',
        type: 'uint8',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: 'enum SharesFactory.ImplementationType',
            name: 'implementationType',
            type: 'uint8',
          },
          {
            components: [
              {
                internalType: 'address',
                name: 'tokenAddress',
                type: 'address',
              },
              {
                internalType: 'uint256',
                name: 'tokenId',
                type: 'uint256',
              },
            ],
            internalType: 'struct TradeableShares.SharesSubject',
            name: 'sharesSubject',
            type: 'tuple',
          },
          {
            internalType: 'address',
            name: 'issuer',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'validFromTimestamp',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'expiresAtTimestamp',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'nonce',
            type: 'uint256',
          },
        ],
        internalType: 'struct SharesFactory.SharesDeploymentRequest',
        name: 'req',
        type: 'tuple',
      },
      {
        internalType: 'bytes',
        name: 'signature',
        type: 'bytes',
      },
    ],
    name: 'executeDeploymentRequest',
    outputs: [
      {
        internalType: 'contract TradeableShares',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'features',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'enum SharesFactory.ImplementationType',
        name: '_implementationType',
        type: 'uint8',
      },
    ],
    name: 'getDistributorImplAddress',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getHoldersFeePercent',
    outputs: [
      {
        internalType: 'uint256',
        name: 'feePercent',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getImplementation',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '_issuer',
        type: 'address',
      },
    ],
    name: 'getNonce',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getPaymentToken',
    outputs: [
      {
        internalType: 'contract ERC1363',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getProtocolFeeDestination',
    outputs: [
      {
        internalType: 'address',
        name: 'feeDestination',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getProtocolFeePercent',
    outputs: [
      {
        internalType: 'uint256',
        name: 'feePercent',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'operator',
        type: 'address',
      },
    ],
    name: 'getRole',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'enum SharesFactory.ImplementationType',
        name: '_implementationType',
        type: 'uint8',
      },
    ],
    name: 'getSharesImplAddress',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getSharesOwnerAddress',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getSubjectFeePercent',
    outputs: [
      {
        internalType: 'uint256',
        name: 'feePercent',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'required',
        type: 'uint256',
      },
    ],
    name: 'isFeatureEnabled',
    outputs: [
      {
        internalType: 'bool',
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'operator',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'required',
        type: 'uint256',
      },
    ],
    name: 'isOperatorInRole',
    outputs: [
      {
        internalType: 'bool',
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'required',
        type: 'uint256',
      },
    ],
    name: 'isSenderInRole',
    outputs: [
      {
        internalType: 'bool',
        name: '',
        type: 'bool',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: 'address',
            name: 'tokenAddress',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'tokenId',
            type: 'uint256',
          },
        ],
        internalType: 'struct TradeableShares.SharesSubject',
        name: '_sharesSubject',
        type: 'tuple',
      },
    ],
    name: 'lookupSharesContract',
    outputs: [
      {
        internalType: 'contract TradeableShares',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'enum SharesFactory.ImplementationType',
        name: '_implementationType',
        type: 'uint8',
      },
      {
        components: [
          {
            internalType: 'address',
            name: 'tokenAddress',
            type: 'address',
          },
          {
            internalType: 'uint256',
            name: 'tokenId',
            type: 'uint256',
          },
        ],
        internalType: 'struct TradeableShares.SharesSubject',
        name: '_sharesSubject',
        type: 'tuple',
      },
      {
        internalType: 'address',
        name: '_issuer',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: '_amount',
        type: 'uint256',
      },
    ],
    name: 'mintSubjectAndDeployShares',
    outputs: [
      {
        internalType: 'contract TradeableShares',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },

  // Admin Functions
  {
    inputs: [],
    name: 'notifySubjectUpdated',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'contract ERC1363',
        name: '_paymentToken',
        type: 'address',
      },
    ],
    name: 'postConstruct',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'contract TradeableShares',
        name: '_sharesContract',
        type: 'address',
      },
    ],
    name: 'registerSharesContract',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '_issuer',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: '_nonce',
        type: 'uint256',
      },
    ],
    name: 'rewindNonce',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'enum SharesFactory.ImplementationType',
        name: '_implementationType',
        type: 'uint8',
      },
      {
        internalType: 'address',
        name: '_implementationAddress',
        type: 'address',
      },
    ],
    name: 'setDistributorImplAddress',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint64',
        name: '_feePercent',
        type: 'uint64',
      },
    ],
    name: 'setHoldersFeePercent',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '_protocolFeeDestination',
        type: 'address',
      },
      {
        internalType: 'uint64',
        name: '_protocolFeePercent',
        type: 'uint64',
      },
      {
        internalType: 'uint64',
        name: '_holdersFeePercent',
        type: 'uint64',
      },
      {
        internalType: 'uint64',
        name: '_subjectFeePercent',
        type: 'uint64',
      },
    ],
    name: 'setProtocolFee',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '_feeDestination',
        type: 'address',
      },
    ],
    name: 'setProtocolFeeDestination',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint64',
        name: '_feePercent',
        type: 'uint64',
      },
    ],
    name: 'setProtocolFeePercent',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'enum SharesFactory.ImplementationType',
        name: '_implementationType',
        type: 'uint8',
      },
      {
        internalType: 'address',
        name: '_implementationAddress',
        type: 'address',
      },
    ],
    name: 'setSharesImplAddress',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: '_sharesOwnerAddress',
        type: 'address',
      },
    ],
    name: 'setSharesOwnerAddress',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint64',
        name: '_feePercent',
        type: 'uint64',
      },
    ],
    name: 'setSubjectFeePercent',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: '_mask',
        type: 'uint256',
      },
    ],
    name: 'updateFeatures',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'operator',
        type: 'address',
      },
      {
        internalType: 'uint256',
        name: 'role',
        type: 'uint256',
      },
    ],
    name: 'updateRole',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  // Upgrade Functions
  {
    inputs: [
      {
        internalType: 'address',
        name: 'newImplementation',
        type: 'address',
      },
    ],
    name: 'upgradeTo',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'newImplementation',
        type: 'address',
      },
      {
        internalType: 'bytes',
        name: 'data',
        type: 'bytes',
      },
    ],
    name: 'upgradeToAndCall',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;
