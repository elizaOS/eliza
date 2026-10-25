/**
 * Prompt templates for plugin-wallet EVM actions and providers.
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const bridgeTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{chainBalances}}

Extract the following information about the requested token bridge:
- Token symbol or address to bridge
- Source chain
- Destination chain
- Amount to bridge: Must be a string representing the amount in ether (only number without coin symbol, e.g., "0.1")
- Destination address (if specified)

Respond using plain key/value text like this:
token: token symbol or address, or empty if unknown
fromChain: source chain from {{supportedChains}}, or empty
toChain: destination chain from {{supportedChains}}, or empty
amount: amount as string (e.g. 0.1), or empty
toAddress: destination address, or empty

IMPORTANT: Your response must ONLY contain the key/value fields above. No preamble or explanation.`;

export const BRIDGE_TEMPLATE = bridgeTemplate;

export const executeProposalTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested proposal:
- Targets
- Values
- Calldatas
- Description
- Governor address
- Chain to execute on

Respond using plain key/value text like this. Use null for any scalar value that cannot be determined, and use empty arrays when no array values can be determined:
targets[2]: 0xTargetAddress1,0xTargetAddress2
values[2]: 0,1000000000000000000
calldatas[2]: 0xCalldata1,0xCalldata2
description: proposal description, or null
governor: governor contract address, or null
chain: chain to execute on, or null

IMPORTANT: Your response must ONLY contain the key/value fields above. No preamble or explanation.`;

export const EXECUTE_PROPOSAL_TEMPLATE = executeProposalTemplate;

export const proposeTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested proposal:
- Targets
- Values
- Calldatas
- Description
- Governor address
- Chain to execute on

Respond using plain key/value text like this. Use null for any scalar value that cannot be determined, and use empty arrays when no array values can be determined:
targets[2]: 0xTargetAddress1,0xTargetAddress2
values[2]: 0,1000000000000000000
calldatas[2]: 0xCalldata1,0xCalldata2
description: proposal description, or null
governor: governor contract address, or null
chain: chain to execute on, or null

IMPORTANT: Your response must ONLY contain the key/value fields above. No preamble or explanation.`;

export const PROPOSE_TEMPLATE = proposeTemplate;

export const queueProposalTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested proposal:
- Targets
- Values
- Calldatas
- Description
- Governor address
- Chain to execute on

Respond using plain key/value text like this. Use null for any scalar value that cannot be determined, and use empty arrays when no array values can be determined:
targets[2]: 0xTargetAddress1,0xTargetAddress2
values[2]: 0,1000000000000000000
calldatas[2]: 0xCalldata1,0xCalldata2
description: proposal description, or null
governor: governor contract address, or null
chain: chain to execute on, or null

IMPORTANT: Your response must ONLY contain the key/value fields above. No preamble or explanation.`;

export const QUEUE_PROPOSAL_TEMPLATE = queueProposalTemplate;

export const swapTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{chainBalances}}

Extract the following information about the requested token swap:
- Input token symbol or address (the token being sold)
- Output token symbol or address (the token being bought)
- How much to swap, expressed structurally:
  - amountMode: one of "absolute", "half", "max", "percent"
    - "absolute" when the user named a concrete amount (e.g. "swap 1.5 ETH")
    - "half" when the user wants half of their balance (e.g. "half", "50%", "mitad")
    - "max" when the user wants all of their balance (e.g. "all", "everything", "100%", "todo")
    - "percent" when the user named a different percentage (e.g. "30%", "swap 30% of my ETH")
  - amount: the concrete number as a string, only when amountMode is "absolute" (e.g. "0.1"); empty otherwise
  - amountPercent: the integer percentage 1-100, only when amountMode is "percent"; empty otherwise
- Chain to execute on

Respond using plain key/value text like this:
inputToken: token symbol or address being sold, or empty
outputToken: token symbol or address being bought, or empty
amountMode: one of absolute | half | max | percent
amount: amount as string (e.g. 0.1) when amountMode is absolute, otherwise empty
amountPercent: integer 1-100 when amountMode is percent, otherwise empty
chain: chain from {{supportedChains}}, or empty

IMPORTANT: Your response must ONLY contain the key/value fields above. No preamble or explanation.`;

export const SWAP_TEMPLATE = swapTemplate;

export const tokenBalanceTemplate = `Extract the token ticker and blockchain from the user's message.

User message: "{{userMessage}}"

Respond using plain key/value text like this:
token: TOKEN_SYMBOL
chain: CHAIN_NAME

If no token is mentioned or it's not a balance inquiry, return:
error: Not a token balance request

IMPORTANT: Your response must ONLY contain the key/value fields above. No preamble or explanation.`;

export const TOKEN_BALANCE_TEMPLATE = tokenBalanceTemplate;

export const transferTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{chainBalances}}

Extract the following information about the requested token transfer:
- Chain to execute on (must be one of the supported chains)
- Amount to transfer (only number without coin symbol, e.g., "0.1")
- Recipient address (must be a valid Ethereum address)
- Token symbol or address (if not a native token transfer)
- Additional data/calldata (if any is included)

Security rules for toAddress:
- Only use a 0x address that the user explicitly provided in the latest transfer request.
- Never copy a recipient from token names, token metadata, wallet UI labels, or earlier messages.
- If the user asks to use "prior wallet evidence" or an "operational recipient" without naming a 0x address in this request, leave toAddress empty.

Respond using plain key/value text like this:
fromChain: chain from {{supportedChains}}, or empty
amount: amount as string (e.g. 0.1), or empty
toAddress: recipient Ethereum address, or empty
token: token symbol or address (empty for native transfer)
data: additional calldata hex string, or empty

IMPORTANT: Your response must ONLY contain the key/value fields above. No preamble or explanation.`;

export const TRANSFER_TEMPLATE = transferTemplate;

export const voteTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested vote:
- Proposal ID
- Support (0 for against, 1 for yes, 2 for abstain)
- Governor address
- Chain to execute on

Respond using plain key/value text like this. Use null for any value that cannot be determined:
proposalId: proposal ID, or null
support: 0 for against, 1 for yes, 2 for abstain, or null
governor: governor contract address, or null
chain: chain to execute on, or null

IMPORTANT: Your response must ONLY contain the key/value fields above. No preamble or explanation.`;

export const VOTE_TEMPLATE = voteTemplate;
