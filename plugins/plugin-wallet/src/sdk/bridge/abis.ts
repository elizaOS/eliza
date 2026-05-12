// [MAX-ADDED] CCTP V2 Contract ABIs — Circle Cross-Chain Transfer Protocol V2
// Sources: https://developers.circle.com/stablecoins/cctp-protocol-contract
/**
 * CCTP V2 TokenMessengerV2 ABI (source chain)
 * Key function: depositForBurn — burns USDC and emits a MessageSent event
 */
export const TokenMessengerV2Abi = [
  {
    name: "depositForBurn",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [{ name: "nonce", type: "uint64" }],
  },
  {
    name: "depositForBurnWithHook",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "nonce", type: "uint64" }],
  },
  {
    name: "localMessageTransmitter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "localDomain",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
];
/**
 * CCTP V2 MessageTransmitterV2 ABI (destination chain)
 * Key function: receiveMessage — mints USDC using attested message
 */
export const MessageTransmitterV2Abi = [
  {
    name: "receiveMessage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    name: "usedNonces",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "localDomain",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
];
/**
 * Minimal ERC20 ABI — approve + allowance + balanceOf
 */
export const ERC20BridgeAbi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];
/**
 * MessageTransmitter MessageSent event ABI — emitted during depositForBurn
 * Used to extract the CCTP message bytes and hash for attestation polling.
 */
export const MessageSentEventAbi = [
  {
    name: "MessageSent",
    type: "event",
    inputs: [{ name: "message", type: "bytes", indexed: false }],
  },
];
