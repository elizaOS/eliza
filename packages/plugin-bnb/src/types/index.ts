import type { Address, Hash } from "viem";

export type SupportedChain = "bsc" | "bscTestnet" | "opBNB" | "opBNBTestnet";
export type StakeAction = "deposit" | "withdraw" | "claim";

// Action parameters
export interface GetBalanceParams {
    chain: SupportedChain;
    address?: Address;
    token: string;
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

export interface StakeParams {
    chain: SupportedChain;
    action: StakeAction;
    amount?: string;
}

export interface FaucetParams {
    token?: string;
    toAddress?: Address;
}

// Action return types
export interface GetBalanceResponse {
    chain: SupportedChain;
    address: Address;
    balance?: { token: string; amount: string };
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
    response: string;
}

export interface FaucetResponse {
    token: string;
    recipient: Address;
    txHash: Hash;
}

export interface IDeployERC20Params {
    chain: SupportedChain;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
}

export interface IDeployERC721Params {
    chain: SupportedChain;
    name: string;
    symbol: string;
    baseURI: string;
}

export interface IDeployERC1155Params {
    chain: SupportedChain;
    name: string;
    baseURI: string;
}

// Contract ABIs
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
        inputs: [
            {
                name: "_owner",
                type: "address",
                internalType: "address payable",
            },
            {
                name: "_delegationFee",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        stateMutability: "nonpayable",
    },
    {
        name: "AddressEmptyCode",
        type: "error",
        inputs: [{ name: "target", type: "address", internalType: "address" }],
    },
    {
        name: "AddressInsufficientBalance",
        type: "error",
        inputs: [{ name: "account", type: "address", internalType: "address" }],
    },
    { name: "FailedInnerCall", type: "error", inputs: [] },
    {
        name: "OwnableInvalidOwner",
        type: "error",
        inputs: [{ name: "owner", type: "address", internalType: "address" }],
    },
    {
        name: "OwnableUnauthorizedAccount",
        type: "error",
        inputs: [{ name: "account", type: "address", internalType: "address" }],
    },
    {
        name: "SafeERC20FailedOperation",
        type: "error",
        inputs: [{ name: "token", type: "address", internalType: "address" }],
    },
    {
        name: "OwnershipTransferred",
        type: "event",
        inputs: [
            {
                name: "previousOwner",
                type: "address",
                indexed: true,
                internalType: "address",
            },
            {
                name: "newOwner",
                type: "address",
                indexed: true,
                internalType: "address",
            },
        ],
        anonymous: false,
        signature:
            "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
    },
    {
        name: "SetDelegationFee",
        type: "event",
        inputs: [
            {
                name: "_delegationFee",
                type: "uint256",
                indexed: false,
                internalType: "uint256",
            },
        ],
        anonymous: false,
        signature:
            "0x0322f3257c2afe5fe8da7ab561f0d3384148487412fe2751678f2188731c0815",
    },
    {
        name: "WithdrawTo",
        type: "event",
        inputs: [
            {
                name: "from",
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
                name: "minGasLimit",
                type: "uint32",
                indexed: false,
                internalType: "uint32",
            },
            {
                name: "extraData",
                type: "bytes",
                indexed: false,
                internalType: "bytes",
            },
        ],
        anonymous: false,
        signature:
            "0x56f66275d9ebc94b7d6895aa0d96a3783550d0183ba106408d387d19f2e877f1",
    },
    {
        name: "L2_STANDARD_BRIDGE",
        type: "function",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                value: "0x4200000000000000000000000000000000000010",
                internalType: "contract IL2StandardBridge",
            },
        ],
        constant: true,
        signature: "0x21d12763",
        stateMutability: "view",
    },
    {
        name: "L2_STANDARD_BRIDGE_ADDRESS",
        type: "function",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                value: "0x4200000000000000000000000000000000000010",
                internalType: "address",
            },
        ],
        constant: true,
        signature: "0x2cb7cb06",
        stateMutability: "view",
    },
    {
        name: "delegationFee",
        type: "function",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "uint256",
                value: "2000000000000000",
                internalType: "uint256",
            },
        ],
        constant: true,
        signature: "0xc5f0a58f",
        stateMutability: "view",
    },
    {
        name: "owner",
        type: "function",
        inputs: [],
        outputs: [
            {
                name: "",
                type: "address",
                value: "0xCe4750fDc02A07Eb0d99cA798CD5c170D8F8410A",
                internalType: "address",
            },
        ],
        constant: true,
        signature: "0x8da5cb5b",
        stateMutability: "view",
    },
    {
        name: "renounceOwnership",
        type: "function",
        inputs: [],
        outputs: [],
        signature: "0x715018a6",
        stateMutability: "nonpayable",
    },
    {
        name: "setDelegationFee",
        type: "function",
        inputs: [
            {
                name: "_delegationFee",
                type: "uint256",
                internalType: "uint256",
            },
        ],
        outputs: [],
        signature: "0x55bfc81c",
        stateMutability: "nonpayable",
    },
    {
        name: "transferOwnership",
        type: "function",
        inputs: [
            { name: "newOwner", type: "address", internalType: "address" },
        ],
        outputs: [],
        signature: "0xf2fde38b",
        stateMutability: "nonpayable",
    },
    {
        name: "withdraw",
        type: "function",
        inputs: [
            { name: "_l2Token", type: "address", internalType: "address" },
            { name: "_amount", type: "uint256", internalType: "uint256" },
            { name: "_minGasLimit", type: "uint32", internalType: "uint32" },
            { name: "_extraData", type: "bytes", internalType: "bytes" },
        ],
        outputs: [],
        payable: true,
        signature: "0x32b7006d",
        stateMutability: "payable",
    },
    {
        name: "withdrawFee",
        type: "function",
        inputs: [
            { name: "_recipient", type: "address", internalType: "address" },
        ],
        outputs: [],
        signature: "0x1ac3ddeb",
        stateMutability: "nonpayable",
    },
    {
        name: "withdrawFeeToL1",
        type: "function",
        inputs: [
            { name: "_recipient", type: "address", internalType: "address" },
            { name: "_minGasLimit", type: "uint32", internalType: "uint32" },
            { name: "_extraData", type: "bytes", internalType: "bytes" },
        ],
        outputs: [],
        signature: "0x244cafe0",
        stateMutability: "nonpayable",
    },
    {
        name: "withdrawTo",
        type: "function",
        inputs: [
            { name: "_l2Token", type: "address", internalType: "address" },
            { name: "_to", type: "address", internalType: "address" },
            { name: "_amount", type: "uint256", internalType: "uint256" },
            { name: "_minGasLimit", type: "uint32", internalType: "uint32" },
            { name: "_extraData", type: "bytes", internalType: "bytes" },
        ],
        outputs: [],
        payable: true,
        signature: "0xa3a79548",
        stateMutability: "payable",
    },
] as const;

export const ListaDaoAbi = [
    { inputs: [], stateMutability: "nonpayable", type: "constructor" },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_account",
                type: "address",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "ClaimAllWithdrawals",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint256",
                name: "_uuid",
                type: "uint256",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "ClaimUndelegated",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_validator",
                type: "address",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_uuid",
                type: "uint256",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "ClaimUndelegatedFrom",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_account",
                type: "address",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_idx",
                type: "uint256",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "ClaimWithdrawal",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "Delegate",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "address",
                name: "_validator",
                type: "address",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
            {
                indexed: false,
                internalType: "bool",
                name: "_delegateVotePower",
                type: "bool",
            },
        ],
        name: "DelegateTo",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "address",
                name: "_delegateTo",
                type: "address",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_votesChange",
                type: "uint256",
            },
        ],
        name: "DelegateVoteTo",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "address",
                name: "_src",
                type: "address",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "Deposit",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_address",
                type: "address",
            },
        ],
        name: "DisableValidator",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint8",
                name: "version",
                type: "uint8",
            },
        ],
        name: "Initialized",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "address",
                name: "account",
                type: "address",
            },
        ],
        name: "Paused",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_address",
                type: "address",
            },
        ],
        name: "ProposeManager",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "address",
                name: "_src",
                type: "address",
            },
            {
                indexed: false,
                internalType: "address",
                name: "_dest",
                type: "address",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "ReDelegate",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint256",
                name: "_rewardsId",
                type: "uint256",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "Redelegate",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_address",
                type: "address",
            },
        ],
        name: "RemoveValidator",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_account",
                type: "address",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_amountInSlisBnb",
                type: "uint256",
            },
        ],
        name: "RequestWithdraw",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "RewardsCompounded",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
            },
            {
                indexed: true,
                internalType: "bytes32",
                name: "previousAdminRole",
                type: "bytes32",
            },
            {
                indexed: true,
                internalType: "bytes32",
                name: "newAdminRole",
                type: "bytes32",
            },
        ],
        name: "RoleAdminChanged",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
            },
            {
                indexed: true,
                internalType: "address",
                name: "account",
                type: "address",
            },
            {
                indexed: true,
                internalType: "address",
                name: "sender",
                type: "address",
            },
        ],
        name: "RoleGranted",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
            },
            {
                indexed: true,
                internalType: "address",
                name: "account",
                type: "address",
            },
            {
                indexed: true,
                internalType: "address",
                name: "sender",
                type: "address",
            },
        ],
        name: "RoleRevoked",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint256",
                name: "_annualRate",
                type: "uint256",
            },
        ],
        name: "SetAnnualRate",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_address",
                type: "address",
            },
        ],
        name: "SetBSCValidator",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_address",
                type: "address",
            },
        ],
        name: "SetManager",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint256",
                name: "_minBnb",
                type: "uint256",
            },
        ],
        name: "SetMinBnb",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_address",
                type: "address",
            },
        ],
        name: "SetRedirectAddress",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "SetReserveAmount",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_address",
                type: "address",
            },
        ],
        name: "SetRevenuePool",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint256",
                name: "_synFee",
                type: "uint256",
            },
        ],
        name: "SetSynFee",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_validator",
                type: "address",
            },
            {
                indexed: false,
                internalType: "address",
                name: "_credit",
                type: "address",
            },
            {
                indexed: false,
                internalType: "bool",
                name: "toRemove",
                type: "bool",
            },
        ],
        name: "SyncCreditContract",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint256",
                name: "_nextUndelegatedRequestIndex",
                type: "uint256",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_bnbAmount",
                type: "uint256",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_shares",
                type: "uint256",
            },
        ],
        name: "Undelegate",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_operator",
                type: "address",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_bnbAmount",
                type: "uint256",
            },
            {
                indexed: false,
                internalType: "uint256",
                name: "_shares",
                type: "uint256",
            },
        ],
        name: "UndelegateFrom",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "uint256",
                name: "_amount",
                type: "uint256",
            },
        ],
        name: "UndelegateReserve",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: false,
                internalType: "address",
                name: "account",
                type: "address",
            },
        ],
        name: "Unpaused",
        type: "event",
    },
    {
        anonymous: false,
        inputs: [
            {
                indexed: true,
                internalType: "address",
                name: "_address",
                type: "address",
            },
        ],
        name: "WhitelistValidator",
        type: "event",
    },
    {
        inputs: [],
        name: "BOT",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "DEFAULT_ADMIN_ROLE",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "GUARDIAN",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "TEN_DECIMALS",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "acceptNewManager",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "amountToDelegate",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "annualRate",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "uint256", name: "_bnbAmount", type: "uint256" },
        ],
        name: "binarySearchCoveredMaxIndex",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_validator", type: "address" },
        ],
        name: "claimUndelegated",
        outputs: [
            { internalType: "uint256", name: "_uuid", type: "uint256" },
            { internalType: "uint256", name: "_amount", type: "uint256" },
        ],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "_idx", type: "uint256" }],
        name: "claimWithdraw",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_user", type: "address" },
            { internalType: "uint256", name: "_idx", type: "uint256" },
        ],
        name: "claimWithdrawFor",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "compoundRewards",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_operator", type: "address" },
            { internalType: "uint256", name: "_bnbAmount", type: "uint256" },
        ],
        name: "convertBnbToShares",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "_amount", type: "uint256" }],
        name: "convertBnbToSnBnb",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_operator", type: "address" },
            { internalType: "uint256", name: "_shares", type: "uint256" },
        ],
        name: "convertSharesToBnb",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            {
                internalType: "uint256",
                name: "_amountInSlisBnb",
                type: "uint256",
            },
        ],
        name: "convertSnBnbToBnb",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        name: "creditContracts",
        outputs: [{ internalType: "address", name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "address", name: "", type: "address" }],
        name: "creditStates",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_validator", type: "address" },
            { internalType: "uint256", name: "_amount", type: "uint256" },
        ],
        name: "delegateTo",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "delegateVotePower",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_delegateTo", type: "address" },
        ],
        name: "delegateVoteTo",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "deposit",
        outputs: [],
        stateMutability: "payable",
        type: "function",
    },
    {
        inputs: [],
        name: "depositReserve",
        outputs: [],
        stateMutability: "payable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_address", type: "address" },
        ],
        name: "disableValidator",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "getAmountToUndelegate",
        outputs: [
            {
                internalType: "uint256",
                name: "_amountToUndelegate",
                type: "uint256",
            },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "_uuid", type: "uint256" }],
        name: "getBotUndelegateRequest",
        outputs: [
            {
                components: [
                    {
                        internalType: "uint256",
                        name: "startTime",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "endTime",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "amount",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "amountInSnBnb",
                        type: "uint256",
                    },
                ],
                internalType: "struct IStakeManager.BotUndelegateRequest",
                name: "",
                type: "tuple",
            },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_validator", type: "address" },
        ],
        name: "getClaimableAmount",
        outputs: [
            { internalType: "uint256", name: "_amount", type: "uint256" },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "getContracts",
        outputs: [
            { internalType: "address", name: "_manager", type: "address" },
            { internalType: "address", name: "_slisBnb", type: "address" },
            { internalType: "address", name: "_bscValidator", type: "address" },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_validator", type: "address" },
        ],
        name: "getDelegated",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "_amount", type: "uint256" }],
        name: "getRedelegateFee",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "bytes32", name: "role", type: "bytes32" }],
        name: "getRoleAdmin",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "getSlisBnbWithdrawLimit",
        outputs: [
            {
                internalType: "uint256",
                name: "_slisBnbWithdrawLimit",
                type: "uint256",
            },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "getTotalBnbInValidators",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "getTotalPooledBnb",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_user", type: "address" },
            { internalType: "uint256", name: "_idx", type: "uint256" },
        ],
        name: "getUserRequestStatus",
        outputs: [
            { internalType: "bool", name: "_isClaimable", type: "bool" },
            { internalType: "uint256", name: "_amount", type: "uint256" },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_address", type: "address" },
        ],
        name: "getUserWithdrawalRequests",
        outputs: [
            {
                components: [
                    { internalType: "uint256", name: "uuid", type: "uint256" },
                    {
                        internalType: "uint256",
                        name: "amountInSnBnb",
                        type: "uint256",
                    },
                    {
                        internalType: "uint256",
                        name: "startTime",
                        type: "uint256",
                    },
                ],
                internalType: "struct IStakeManager.WithdrawalRequest[]",
                name: "",
                type: "tuple[]",
            },
        ],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "bytes32", name: "role", type: "bytes32" },
            { internalType: "address", name: "account", type: "address" },
        ],
        name: "grantRole",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "bytes32", name: "role", type: "bytes32" },
            { internalType: "address", name: "account", type: "address" },
        ],
        name: "hasRole",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_slisBnb", type: "address" },
            { internalType: "address", name: "_admin", type: "address" },
            { internalType: "address", name: "_manager", type: "address" },
            { internalType: "address", name: "_bot", type: "address" },
            { internalType: "uint256", name: "_synFee", type: "uint256" },
            { internalType: "address", name: "_revenuePool", type: "address" },
            { internalType: "address", name: "_validator", type: "address" },
        ],
        name: "initialize",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "minBnb",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "nextConfirmedRequestUUID",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "pause",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "paused",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "placeholder",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_address", type: "address" },
        ],
        name: "proposeNewManager",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "srcValidator", type: "address" },
            { internalType: "address", name: "dstValidator", type: "address" },
            { internalType: "uint256", name: "_amount", type: "uint256" },
        ],
        name: "redelegate",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "redirectAddress",
        outputs: [{ internalType: "address", name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_address", type: "address" },
        ],
        name: "removeValidator",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "bytes32", name: "role", type: "bytes32" },
            { internalType: "address", name: "account", type: "address" },
        ],
        name: "renounceRole",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        name: "requestIndexMap",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "requestUUID",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            {
                internalType: "uint256",
                name: "_amountInSlisBnb",
                type: "uint256",
            },
        ],
        name: "requestWithdraw",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "reserveAmount",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "revenuePool",
        outputs: [{ internalType: "address", name: "", type: "address" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_address", type: "address" },
        ],
        name: "revokeBotRole",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "bytes32", name: "role", type: "bytes32" },
            { internalType: "address", name: "account", type: "address" },
        ],
        name: "revokeRole",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "uint256", name: "_annualRate", type: "uint256" },
        ],
        name: "setAnnualRate",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_address", type: "address" },
        ],
        name: "setBSCValidator",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_address", type: "address" },
        ],
        name: "setBotRole",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "_amount", type: "uint256" }],
        name: "setMinBnb",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_address", type: "address" },
        ],
        name: "setRedirectAddress",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
        name: "setReserveAmount",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_address", type: "address" },
        ],
        name: "setRevenuePool",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "_synFee", type: "uint256" }],
        name: "setSynFee",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "bytes4", name: "interfaceId", type: "bytes4" },
        ],
        name: "supportsInterface",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "synFee",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "togglePause",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "toggleVote",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "totalDelegated",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "totalReserveAmount",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "unbondingBnb",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [],
        name: "undelegate",
        outputs: [
            { internalType: "uint256", name: "_uuid", type: "uint256" },
            { internalType: "uint256", name: "_amount", type: "uint256" },
        ],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_operator", type: "address" },
            { internalType: "uint256", name: "_amount", type: "uint256" },
        ],
        name: "undelegateFrom",
        outputs: [
            {
                internalType: "uint256",
                name: "_actualBnbAmount",
                type: "uint256",
            },
        ],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "undelegatedQuota",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [{ internalType: "address", name: "", type: "address" }],
        name: "validators",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
    {
        inputs: [
            { internalType: "address", name: "_address", type: "address" },
        ],
        name: "whitelistValidator",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
        name: "withdrawReserve",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    { stateMutability: "payable", type: "receive" },
] as const;
