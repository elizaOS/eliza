import type { Address, Hash } from "viem";

export type SupportedChain = "bsc" | "bscTestnet" | "opBNB" | "opBNBTestnet";
export type StakeAction = "delegate" | "undelegate" | "redelegate" | "claim";

export interface Balance {
    token: string;
    balance: string;
}

// Action parameters
export interface GetBalanceParams {
    chain: SupportedChain;
    address?: Address;
    token?: string;
}

export interface TransferParams {
    chain: SupportedChain;
    token?: string;
    amount?: string;
    toAddress: Address;
    data?: `0x${string}`;
}

export interface SwapParams {
    chain: SupportedChain;
    fromToken: string;
    toToken: string;
    amount: string;
    slippage?: number;
}

export interface BridgeParams {
    fromChain: SupportedChain;
    toChain: SupportedChain;
    fromToken?: Address;
    toToken?: Address;
    amount: string;
    toAddress?: Address;
}

export interface FaucetParams {
    chain: SupportedChain;
    toAddress: Address;
}

export interface StakeParams {
    action: StakeAction;
    amount: string;
    fromValidator?: Address;
    toValidator?: Address;
    delegateVotePower: boolean;
}

// Action return types
export interface GetBalanceResponse {
    chain: SupportedChain;
    address: Address;
    balances: Balance[];
}

export interface TransferResponse {
    chain: SupportedChain;
    txHash: Hash;
    recipient: Address;
    amount: string;
    token: string;
    data?: `0x${string}`;
}

export interface SwapResponse {
    chain: SupportedChain;
    txHash: Hash;
    fromToken: string;
    toToken: string;
    amount: string;
}

export interface BridgeResponse {
    fromChain: SupportedChain;
    toChain: SupportedChain;
    txHash: Hash;
    recipient: Address;
    fromToken: string;
    toToken: string;
    amount: string;
}

export interface StakeResponse {
    txHash: Hash;
}

// Contract ABIs
export const ERC20Abi = [
    {
        type: "constructor",
        inputs: [
            {
                name: "name_",
                type: "string",
                internalType: "string",
            },
            {
                name: "symbol_",
                type: "string",
                internalType: "string",
            },
        ],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "allowance",
        inputs: [
            {
                name: "owner",
                type: "address",
                internalType: "address",
            },
            {
                name: "spender",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "approve",
        inputs: [
            {
                name: "spender",
                type: "address",
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool",
            },
        ],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "balanceOf",
        inputs: [
            {
                name: "account",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "decimals",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint8",
                internalType: "uint8",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "decreaseAllowance",
        inputs: [
            {
                name: "spender",
                type: "address",
                internalType: "address",
            },
            {
                name: "subtractedValue",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool",
            },
        ],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "increaseAllowance",
        inputs: [
            {
                name: "spender",
                type: "address",
                internalType: "address",
            },
            {
                name: "addedValue",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool",
            },
        ],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "name",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "string",
                internalType: "string",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "symbol",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "string",
                internalType: "string",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "totalSupply",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "transfer",
        inputs: [
            {
                name: "to",
                type: "address",
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool",
            },
        ],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "transferFrom",
        inputs: [
            {
                name: "from",
                type: "address",
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool",
            },
        ],
        stateMutability: "nonpayable",
    },
    {
        type: "event",
        name: "Approval",
        inputs: [
            {
                name: "owner",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "spender",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "value",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Transfer",
        inputs: [
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "value",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
        ],
        anonymous: false,
    },
] as const;

export const L1StandardBridgeAbi = [
    {
        type: "constructor",
        inputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "receive",
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "MESSENGER",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "contract CrossDomainMessenger",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "OTHER_BRIDGE",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "contract StandardBridge",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "bridgeERC20",
        inputs: [
            {
                name: "_localToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_remoteToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "bridgeERC20To",
        inputs: [
            {
                name: "_localToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_remoteToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "bridgeETH",
        inputs: [
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "bridgeETHTo",
        inputs: [
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "depositERC20",
        inputs: [
            {
                name: "_l1Token",
                type: "address",
                internalType: "address",
            },
            {
                name: "_l2Token",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "depositERC20To",
        inputs: [
            {
                name: "_l1Token",
                type: "address",
                internalType: "address",
            },
            {
                name: "_l2Token",
                type: "address",
                internalType: "address",
            },
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "depositETH",
        inputs: [
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "depositETHTo",
        inputs: [
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "deposits",
        inputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "finalizeBridgeERC20",
        inputs: [
            {
                name: "_localToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_remoteToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_from",
                type: "address",
                internalType: "address",
            },
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "finalizeBridgeETH",
        inputs: [
            {
                name: "_from",
                type: "address",
                internalType: "address",
            },
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "finalizeERC20Withdrawal",
        inputs: [
            {
                name: "_l1Token",
                type: "address",
                internalType: "address",
            },
            {
                name: "_l2Token",
                type: "address",
                internalType: "address",
            },
            {
                name: "_from",
                type: "address",
                internalType: "address",
            },
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "finalizeETHWithdrawal",
        inputs: [
            {
                name: "_from",
                type: "address",
                internalType: "address",
            },
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "initialize",
        inputs: [
            {
                name: "_messenger",
                type: "address",
                internalType: "contract CrossDomainMessenger",
            },
            {
                name: "_superchainConfig",
                type: "address",
                internalType: "contract SuperchainConfig",
            },
            {
                name: "_systemConfig",
                type: "address",
                internalType: "contract SystemConfig",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "l2TokenBridge",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "messenger",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "contract CrossDomainMessenger",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "otherBridge",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "contract StandardBridge",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "paused",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "superchainConfig",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "contract SuperchainConfig",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "systemConfig",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "contract SystemConfig",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "version",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "string",
                internalType: "string",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "event",
        name: "ERC20BridgeFinalized",
        inputs: [
            {
                name: "localToken",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "remoteToken",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: false,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ERC20BridgeInitiated",
        inputs: [
            {
                name: "localToken",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "remoteToken",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: false,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ERC20DepositInitiated",
        inputs: [
            {
                name: "l1Token",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "l2Token",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: false,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ERC20WithdrawalFinalized",
        inputs: [
            {
                name: "l1Token",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "l2Token",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: false,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ETHBridgeFinalized",
        inputs: [
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ETHBridgeInitiated",
        inputs: [
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ETHDepositInitiated",
        inputs: [
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ETHWithdrawalFinalized",
        inputs: [
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Initialized",
        inputs: [
            {
                name: "version",
                type: "uint8",
                indexed: false,
                internalType: "uint8",
            },
        ],
        anonymous: false,
    },
] as const;

export const L2StandardBridgeAbi = [
    {
        type: "constructor",
        inputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "receive",
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "MESSENGER",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "contract CrossDomainMessenger",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "OTHER_BRIDGE",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "contract StandardBridge",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "bridgeERC20",
        inputs: [
            {
                name: "_localToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_remoteToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "bridgeERC20To",
        inputs: [
            {
                name: "_localToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_remoteToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "bridgeETH",
        inputs: [
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "bridgeETHTo",
        inputs: [
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "deposits",
        inputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "finalizeBridgeERC20",
        inputs: [
            {
                name: "_localToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_remoteToken",
                type: "address",
                internalType: "address",
            },
            {
                name: "_from",
                type: "address",
                internalType: "address",
            },
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "finalizeBridgeETH",
        inputs: [
            {
                name: "_from",
                type: "address",
                internalType: "address",
            },
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "initialize",
        inputs: [
            {
                name: "_otherBridge",
                type: "address",
                internalType: "contract StandardBridge",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "l1TokenBridge",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "messenger",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "contract CrossDomainMessenger",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "otherBridge",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "contract StandardBridge",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "paused",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "version",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "string",
                internalType: "string",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "withdraw",
        inputs: [
            {
                name: "_l2Token",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "withdrawTo",
        inputs: [
            {
                name: "_l2Token",
                type: "address",
                internalType: "address",
            },
            {
                name: "_to",
                type: "address",
                internalType: "address",
            },
            {
                name: "_amount",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "_minGasLimit",
                type: "uint32",
                internalType: "uint32",
            },
            {
                name: "_extraData",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "event",
        name: "DepositFinalized",
        inputs: [
            {
                name: "l1Token",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "l2Token",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: false,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ERC20BridgeFinalized",
        inputs: [
            {
                name: "localToken",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "remoteToken",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: false,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ERC20BridgeInitiated",
        inputs: [
            {
                name: "localToken",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "remoteToken",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: false,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ETHBridgeFinalized",
        inputs: [
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ETHBridgeInitiated",
        inputs: [
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Initialized",
        inputs: [
            {
                name: "version",
                type: "uint8",
                indexed: false,
                internalType: "uint8",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "WithdrawalInitiated",
        inputs: [
            {
                name: "l1Token",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "l2Token",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "from",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "to",
                type: "address",
                indexed: false,
                internalType: "address",
            },
            {
                name: "amount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
];

export const StakeHubAbi = [
    {
        type: "receive",
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "BREATHE_BLOCK_INTERVAL",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "DEAD_ADDRESS",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "LOCK_AMOUNT",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "REDELEGATE_FEE_RATE_BASE",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "addToBlackList",
        inputs: [
            {
                name: "account",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "agentToOperator",
        inputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "blackList",
        inputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "claim",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
            {
                name: "requestNumber",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "claimBatch",
        inputs: [
            {
                name: "operatorAddresses",
                type: "address[]",
                internalType: "address[]",
            },
            {
                name: "requestNumbers",
                type: "uint256[]",
                internalType: "uint256[]",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "consensusExpiration",
        inputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "consensusToOperator",
        inputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "createValidator",
        inputs: [
            {
                name: "consensusAddress",
                type: "address",
                internalType: "address",
            },
            {
                name: "voteAddress",
                type: "bytes",
                internalType: "bytes",
            },
            {
                name: "blsProof",
                type: "bytes",
                internalType: "bytes",
            },
            {
                name: "commission",
                type: "tuple",
                internalType: "struct StakeHub.Commission",
                components: [
                    {
                        name: "rate",
                        type: "uint64",
                        internalType: "uint64",
                    },
                    {
                        name: "maxRate",
                        type: "uint64",
                        internalType: "uint64",
                    },
                    {
                        name: "maxChangeRate",
                        type: "uint64",
                        internalType: "uint64",
                    },
                ],
            },
            {
                name: "description",
                type: "tuple",
                internalType: "struct StakeHub.Description",
                components: [
                    {
                        name: "moniker",
                        type: "string",
                        internalType: "string",
                    },
                    {
                        name: "identity",
                        type: "string",
                        internalType: "string",
                    },
                    {
                        name: "website",
                        type: "string",
                        internalType: "string",
                    },
                    {
                        name: "details",
                        type: "string",
                        internalType: "string",
                    },
                ],
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "delegate",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
            {
                name: "delegateVotePower",
                type: "bool",
                internalType: "bool",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "distributeReward",
        inputs: [
            {
                name: "consensusAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "doubleSignSlash",
        inputs: [
            {
                name: "consensusAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "downtimeJailTime",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "downtimeSlash",
        inputs: [
            {
                name: "consensusAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "downtimeSlashAmount",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "editCommissionRate",
        inputs: [
            {
                name: "commissionRate",
                type: "uint64",
                internalType: "uint64",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "editConsensusAddress",
        inputs: [
            {
                name: "newConsensusAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "editDescription",
        inputs: [
            {
                name: "description",
                type: "tuple",
                internalType: "struct StakeHub.Description",
                components: [
                    {
                        name: "moniker",
                        type: "string",
                        internalType: "string",
                    },
                    {
                        name: "identity",
                        type: "string",
                        internalType: "string",
                    },
                    {
                        name: "website",
                        type: "string",
                        internalType: "string",
                    },
                    {
                        name: "details",
                        type: "string",
                        internalType: "string",
                    },
                ],
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "editVoteAddress",
        inputs: [
            {
                name: "newVoteAddress",
                type: "bytes",
                internalType: "bytes",
            },
            {
                name: "blsProof",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "felonyJailTime",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "felonySlashAmount",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getProtector",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorAgent",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorBasicInfo",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "createdTime",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "jailed",
                type: "bool",
                internalType: "bool",
            },
            {
                name: "jailUntil",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorCommission",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "tuple",
                internalType: "struct StakeHub.Commission",
                components: [
                    {
                        name: "rate",
                        type: "uint64",
                        internalType: "uint64",
                    },
                    {
                        name: "maxRate",
                        type: "uint64",
                        internalType: "uint64",
                    },
                    {
                        name: "maxChangeRate",
                        type: "uint64",
                        internalType: "uint64",
                    },
                ],
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorConsensusAddress",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "consensusAddress",
                type: "address",
                internalType: "address",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorCreditContract",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "creditContract",
                type: "address",
                internalType: "address",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorDescription",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "tuple",
                internalType: "struct StakeHub.Description",
                components: [
                    {
                        name: "moniker",
                        type: "string",
                        internalType: "string",
                    },
                    {
                        name: "identity",
                        type: "string",
                        internalType: "string",
                    },
                    {
                        name: "website",
                        type: "string",
                        internalType: "string",
                    },
                    {
                        name: "details",
                        type: "string",
                        internalType: "string",
                    },
                ],
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorElectionInfo",
        inputs: [
            {
                name: "offset",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "limit",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [
            {
                name: "consensusAddrs",
                type: "address[]",
                internalType: "address[]",
            },
            {
                name: "votingPowers",
                type: "uint256[]",
                internalType: "uint256[]",
            },
            {
                name: "voteAddrs",
                type: "bytes[]",
                internalType: "bytes[]",
            },
            {
                name: "totalLength",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorRewardRecord",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
            {
                name: "index",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorTotalPooledBNBRecord",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
            {
                name: "index",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorUpdateTime",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidatorVoteAddress",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [
            {
                name: "voteAddress",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getValidators",
        inputs: [
            {
                name: "offset",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "limit",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [
            {
                name: "operatorAddrs",
                type: "address[]",
                internalType: "address[]",
            },
            {
                name: "creditAddrs",
                type: "address[]",
                internalType: "address[]",
            },
            {
                name: "totalLength",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "handleAckPackage",
        inputs: [
            {
                name: "channelId",
                type: "uint8",
                internalType: "uint8",
            },
            {
                name: "msgBytes",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "handleFailAckPackage",
        inputs: [
            {
                name: "channelId",
                type: "uint8",
                internalType: "uint8",
            },
            {
                name: "msgBytes",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "handleSynPackage",
        inputs: [
            {
                name: "",
                type: "uint8",
                internalType: "uint8",
            },
            {
                name: "msgBytes",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [
            {
                name: "",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "initialize",
        inputs: [],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "isPaused",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "bool",
                internalType: "bool",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "maliciousVoteSlash",
        inputs: [
            {
                name: "voteAddress",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "maxElectedValidators",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "maxFelonyBetweenBreatheBlock",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "minDelegationBNBChange",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "minSelfDelegationBNB",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "numOfJailed",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "pause",
        inputs: [],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "redelegate",
        inputs: [
            {
                name: "srcValidator",
                type: "address",
                internalType: "address",
            },
            {
                name: "dstValidator",
                type: "address",
                internalType: "address",
            },
            {
                name: "shares",
                type: "uint256",
                internalType: "uint256",
            },
            {
                name: "delegateVotePower",
                type: "bool",
                internalType: "bool",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "redelegateFeeRate",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "removeFromBlackList",
        inputs: [
            {
                name: "account",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "resume",
        inputs: [],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "syncGovToken",
        inputs: [
            {
                name: "operatorAddresses",
                type: "address[]",
                internalType: "address[]",
            },
            {
                name: "account",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "transferGasLimit",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "unbondPeriod",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "undelegate",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
            {
                name: "shares",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "unjail",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "updateAgent",
        inputs: [
            {
                name: "newAgent",
                type: "address",
                internalType: "address",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "updateParam",
        inputs: [
            {
                name: "key",
                type: "string",
                internalType: "string",
            },
            {
                name: "value",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "voteExpiration",
        inputs: [
            {
                name: "",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [
            {
                name: "",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "voteToOperator",
        inputs: [
            {
                name: "",
                type: "bytes",
                internalType: "bytes",
            },
        ],
        outputs: [
            {
                name: "",
                type: "address",
                internalType: "address",
            },
        ],
        stateMutability: "view",
    },
    {
        type: "event",
        name: "AgentChanged",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "oldAgent",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "newAgent",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "BlackListed",
        inputs: [
            {
                name: "target",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Claimed",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "delegator",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "bnbAmount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "CommissionRateEdited",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "newCommissionRate",
                type: "uint64",
                indexed: false,
                internalType: "uint64",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ConsensusAddressEdited",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "newConsensusAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Delegated",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "delegator",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "shares",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "bnbAmount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "DescriptionEdited",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Initialized",
        inputs: [
            {
                name: "version",
                type: "uint8",
                indexed: false,
                internalType: "uint8",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "MigrateFailed",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "delegator",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "bnbAmount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "respCode",
                type: "uint8",
                indexed: false,
                internalType: "enum StakeHub.StakeMigrationRespCode",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "MigrateSuccess",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "delegator",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "shares",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "bnbAmount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ParamChange",
        inputs: [
            {
                name: "key",
                type: "string",
                indexed: false,
                internalType: "string",
            },
            {
                name: "value",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Paused",
        inputs: [],
        anonymous: false,
    },
    {
        type: "event",
        name: "ProtectorChanged",
        inputs: [
            {
                name: "oldProtector",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "newProtector",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Redelegated",
        inputs: [
            {
                name: "srcValidator",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "dstValidator",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "delegator",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "oldShares",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "newShares",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "bnbAmount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Resumed",
        inputs: [],
        anonymous: false,
    },
    {
        type: "event",
        name: "RewardDistributeFailed",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "failReason",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "RewardDistributed",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "reward",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "StakeCreditInitialized",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "creditContract",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "UnBlackListed",
        inputs: [
            {
                name: "target",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "Undelegated",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "delegator",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "shares",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "bnbAmount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "UnexpectedPackage",
        inputs: [
            {
                name: "channelId",
                type: "uint8",
                indexed: false,
                internalType: "uint8",
            },
            {
                name: "msgBytes",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ValidatorCreated",
        inputs: [
            {
                name: "consensusAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "creditContract",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "voteAddress",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ValidatorEmptyJailed",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ValidatorJailed",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ValidatorSlashed",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "jailUntil",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "slashAmount",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
            {
                name: "slashType",
                type: "uint8",
                indexed: false,
                internalType: "enum StakeHub.SlashType",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ValidatorUnjailed",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "VoteAddressEdited",
        inputs: [
            {
                name: "operatorAddress",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "newVoteAddress",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
    },
    {
        type: "error",
        name: "AlreadyPaused",
        inputs: [],
    },
    {
        type: "error",
        name: "AlreadySlashed",
        inputs: [],
    },
    {
        type: "error",
        name: "ConsensusAddressExpired",
        inputs: [],
    },
    {
        type: "error",
        name: "DelegationAmountTooSmall",
        inputs: [],
    },
    {
        type: "error",
        name: "DuplicateConsensusAddress",
        inputs: [],
    },
    {
        type: "error",
        name: "DuplicateMoniker",
        inputs: [],
    },
    {
        type: "error",
        name: "DuplicateVoteAddress",
        inputs: [],
    },
    {
        type: "error",
        name: "InBlackList",
        inputs: [],
    },
    {
        type: "error",
        name: "InvalidAgent",
        inputs: [],
    },
    {
        type: "error",
        name: "InvalidCommission",
        inputs: [],
    },
    {
        type: "error",
        name: "InvalidConsensusAddress",
        inputs: [],
    },
    {
        type: "error",
        name: "InvalidMoniker",
        inputs: [],
    },
    {
        type: "error",
        name: "InvalidRequest",
        inputs: [],
    },
    {
        type: "error",
        name: "InvalidSynPackage",
        inputs: [],
    },
    {
        type: "error",
        name: "InvalidValidator",
        inputs: [],
    },
    {
        type: "error",
        name: "InvalidValue",
        inputs: [
            {
                name: "key",
                type: "string",
                internalType: "string",
            },
            {
                name: "value",
                type: "bytes",
                internalType: "bytes",
            },
        ],
    },
    {
        type: "error",
        name: "InvalidVoteAddress",
        inputs: [],
    },
    {
        type: "error",
        name: "JailTimeNotExpired",
        inputs: [],
    },
    {
        type: "error",
        name: "NoMoreFelonyAllowed",
        inputs: [],
    },
    {
        type: "error",
        name: "NotPaused",
        inputs: [],
    },
    {
        type: "error",
        name: "OnlyCoinbase",
        inputs: [],
    },
    {
        type: "error",
        name: "OnlyProtector",
        inputs: [],
    },
    {
        type: "error",
        name: "OnlySelfDelegation",
        inputs: [],
    },
    {
        type: "error",
        name: "OnlySystemContract",
        inputs: [
            {
                name: "systemContract",
                type: "address",
                internalType: "address",
            },
        ],
    },
    {
        type: "error",
        name: "OnlyZeroGasPrice",
        inputs: [],
    },
    {
        type: "error",
        name: "SameValidator",
        inputs: [],
    },
    {
        type: "error",
        name: "SelfDelegationNotEnough",
        inputs: [],
    },
    {
        type: "error",
        name: "TransferFailed",
        inputs: [],
    },
    {
        type: "error",
        name: "UnknownParam",
        inputs: [
            {
                name: "key",
                type: "string",
                internalType: "string",
            },
            {
                name: "value",
                type: "bytes",
                internalType: "bytes",
            },
        ],
    },
    {
        type: "error",
        name: "UpdateTooFrequently",
        inputs: [],
    },
    {
        type: "error",
        name: "ValidatorExisted",
        inputs: [],
    },
    {
        type: "error",
        name: "ValidatorNotExisted",
        inputs: [],
    },
    {
        type: "error",
        name: "ValidatorNotJailed",
        inputs: [],
    },
    {
        type: "error",
        name: "VoteAddressExpired",
        inputs: [],
    },
    {
        type: "error",
        name: "ZeroShares",
        inputs: [],
    },
] as const;

export interface DeployParams {
    contractType: "erc20" | "erc721" | "erc1155";
    chain: "bsc" | "opBNB" | "bscTestnet" | "opBNBTestnet";
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
}
