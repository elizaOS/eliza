export const ABI = [
    {
        inputs: [],
        name: "name",
        outputs: [
            {
                name: "",
                type: "string",
                internalType: "string"
            }
        ],
        stateMutability: "view",
        type: "function"
    },
    {
        inputs: [
            {
                name: "spender",
                type: "address",
                internalType: "address"
            },
            {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
            }
        ],
        name: "approve",
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool"
            }
        ],
        stateMutability: "nonpayable",
        type: "function"
    },
    {
        inputs: [],
        name: "totalSupply",
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256"
            }
        ],
        stateMutability: "view",
        type: "function"
    },
    {
        inputs: [
            {
                name: "from",
                type: "address",
                internalType: "address"
            },
            {
                name: "to",
                type: "address",
                internalType: "address"
            },
            {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
            }
        ],
        name: "transferFrom",
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool"
            }
        ],
        stateMutability: "nonpayable",
        type: "function"
    },
    {
        inputs: [],
        name: "decimals",
        outputs: [
            {
                name: "",
                type: "uint8",
                internalType: "uint8"
            }
        ],
        stateMutability: "view",
        type: "function"
    },
    {
        inputs: [
            {
                name: "account",
                type: "address",
                internalType: "address"
            }
        ],
        name: "balanceOf",
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256"
            }
        ],
        stateMutability: "view",
        type: "function"
    },
    {
        inputs: [],
        name: "symbol",
        outputs: [
            {
                name: "",
                type: "string",
                internalType: "string"
            }
        ],
        stateMutability: "view",
        type: "function"
    },
    {
        inputs: [
            {
                name: "to",
                type: "address",
                internalType: "address"
            },
            {
                name: "amount",
                type: "uint256",
                internalType: "uint256"
            }
        ],
        name: "transfer",
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool"
            }
        ],
        stateMutability: "nonpayable",
        type: "function"
    },
    {
        inputs: [
            {
                name: "owner",
                type: "address",
                internalType: "address"
            },
            {
                name: "spender",
                type: "address",
                internalType: "address"
            }
        ],
        name: "allowance",
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256"
            }
        ],
        stateMutability: "view",
        type: "function"
    },
    {
        inputs: [
            {
                indexed: true,
                name: "owner",
                type: "address",
                internalType: "address"
            },
            {
                indexed: true,
                name: "spender",
                type: "address",
                internalType: "address"
            },
            {
                indexed: false,
                name: "value",
                type: "uint256",
                internalType: "uint256"
            }
        ],
        name: "Approval",
        type: "event",
        anonymous: false
    },
    {
        inputs: [
            {
                indexed: true,
                name: "from",
                type: "address",
                internalType: "address"
            },
            {
                indexed: true,
                name: "to",
                type: "address",
                internalType: "address"
            },
            {
                indexed: false,
                name: "value",
                type: "uint256",
                internalType: "uint256"
            }
        ],
        name: "Transfer",
        type: "event",
        anonymous: false
    }
];

// CCTP Contract Addresses
export const CCTP_CONTRACTS = {
    BASE: {
        TOKEN_MESSENGER: "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962",
        USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    },
    ARBITRUM: {
        MESSAGE_TRANSMITTER: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca"
    }
} as const;

// CCTP Domain IDs
export const CCTP_DOMAINS = {
    BASE: "6",
    ARBITRUM: "3"
} as const;

// CCTP Contract ABIs
export const CCTP_ABIS = {
    TOKEN_MESSENGER: [
        {
            inputs: [
                { internalType: "uint256", name: "amount", type: "uint256" },
                { internalType: "uint32", name: "destinationDomain", type: "uint32" },
                { internalType: "bytes32", name: "mintRecipient", type: "bytes32" },
                { internalType: "address", name: "burnToken", type: "address" },
            ],
            name: "depositForBurn",
            outputs: [{ internalType: "uint64", name: "_nonce", type: "uint64" }],
            stateMutability: "nonpayable",
            type: "function",
        }
    ],
    MESSAGE_TRANSMITTER: [
        {
            inputs: [
                { internalType: "bytes", name: "message", type: "bytes" },
                { internalType: "bytes", name: "attestation", type: "bytes" },
            ],
            name: "receiveMessage",
            outputs: [{ internalType: "bool", name: "success", type: "bool" }],
            stateMutability: "nonpayable",
            type: "function",
        }
    ]
} as const;

// CCTP API Endpoints
export const CCTP_API = {
    ATTESTATION_API: "https://iris-api.circle.com/attestations"
} as const;