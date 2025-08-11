export const getValidatorInfoTemplate = `You are an AI assistant. Your task is to extract the validator ID from the user\'s message.
The validator ID must be a positive integer.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify the validator ID.

Respond with a JSON markdown block containing only the extracted validator ID.
The JSON should have this structure:
\`\`\`json
{
    "validatorId": number
}
\`\`\`

If no valid validator ID is found, or if the user\'s intent is unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Validator ID not found or invalid. Please specify a positive integer for the validator ID."
}
\`\`\`
`;

export const getDelegatorInfoTemplate = `You are an AI assistant. Your task is to extract the validator ID and optionally a delegator address from the user\'s message.
The validator ID must be a positive integer.
The delegator address, if provided by the user, must be a valid Ethereum-style address (starting with 0x).

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify the validator ID and delegator address (if specified by the user).

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "validatorId": number,
    "delegatorAddress"?: string
}
\`\`\`
If \'delegatorAddress\' is not mentioned by the user, omit it from the JSON.

If no valid validator ID is found, or if the user\'s intent is unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Validator ID not found or invalid. Please specify a positive integer for the validator ID."
}
\`\`\`
`;

export const delegateL1Template = `You are an AI assistant. Your task is to extract the validator ID and the amount to delegate from the user\'s message.
The validator ID must be a positive integer.
The amount must be a positive number, representing the amount in the smallest unit (Wei) as a string.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify the validator ID and the amount to delegate.

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "validatorId": number,
    "amountWei": string
}
\`\`\`

If no valid validator ID or amount is found, or if the user\'s intent is unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Validator ID or amount not found or invalid. Please specify a positive integer for the validator ID and a positive amount in Wei (as a string)."
}
\`\`\`
`;

export const undelegateL1Template = `You are an AI assistant. Your task is to extract the validator ID and the amount of MATIC to undelegate from the user's message.
The validator ID must be a positive integer.
The amount should be treated as MATIC tokens (e.g., "0.1", "0.5 MATIC", "2.5 matic") and will be converted to validator shares automatically.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify the validator ID and the MATIC amount to undelegate.

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "validatorId": number,
    "maticAmount": string
}
\`\`\`

If no valid validator ID or amount is found, or if the user's intent is unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Validator ID or MATIC amount not found or invalid. Please specify a positive integer for the validator ID and a positive MATIC amount (e.g., '0.5' or '0.5 MATIC')."
}
\`\`\`
`;

export const withdrawRewardsTemplate = `You are an AI assistant. Your task is to extract the validator ID from the user\'s message for withdrawing staking rewards.
The validator ID must be a positive integer.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify the validator ID from which to withdraw rewards.

Respond with a JSON markdown block containing only the extracted validator ID.
The JSON should have this structure:
\`\`\`json
{
    "validatorId": number
}
\`\`\`

If no valid validator ID is found, or if the user\'s intent is unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Validator ID not found or invalid. Please specify a positive integer for the validator ID."
}
\`\`\`
`;

export const restakeRewardsL1Template = `You are an AI assistant. Your task is to extract the validator ID from the user\'s message for a restake rewards operation on L1.
The validator ID must be a positive integer.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify the validator ID for which to restake rewards.

Respond with a JSON markdown block containing only the extracted validator ID.
The JSON should have this structure:
\`\`\`json
{
    "validatorId": number
}
\`\`\`

If no valid validator ID is found, or if the user\'s intent is unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Validator ID not found or invalid. Please specify a positive integer for the validator ID."
}
\`\`\`
`;

export const getPolygonGasEstimatesTemplate = `You are an AI assistant. Your task is to determine if the user is asking for Polygon gas estimates.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, determine if the user is requesting information about gas prices or gas estimates on the Polygon network.

Respond with a JSON markdown block indicating whether to retrieve gas estimates.
The JSON should have this structure:
\`\`\`json
{
    "getGasEstimates": boolean
}
\`\`\`

If the user's intent is unclear or unrelated to Polygon gas estimates, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "It's unclear if you're asking for Polygon gas estimates. Please clarify your request."
}
\`\`\`
`;

export const bridgeDepositPolygonTemplate = `You are an AI assistant. Your task is to extract parameters for a bridge deposit between blockchain networks.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, extract the following parameters:
- fromChain: The source blockchain network (e.g., "ethereum", "polygon", "arbitrum")
- toChain: The destination blockchain network (e.g., "ethereum", "polygon", "arbitrum")
- fromToken: The token address on the source chain (string starting with 0x)
- toToken: The token address on the destination chain (string starting with 0x)
- amount: The amount to bridge (string, representing the human-readable amount)
- toAddress (optional): The recipient address on the destination chain (string starting with 0x)

Important notes: 
- Always use "ethereum" (not "mainnet") when referring to the Ethereum network
- Always use "polygon" when referring to the Polygon network
- Always use "arbitrum" when referring to the Arbitrum network

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure and MUST NOT include any comments:
\`\`\`json
{
    "fromChain": string,
    "toChain": string,
    "fromToken": string,
    "toToken": string,
    "amount": string,
    "toAddress"?: string
}
\`\`\`
If 'toAddress' is not mentioned by the user, omit it from the JSON.

IMPORTANT: Your JSON response must be valid JSON without any comments or explanatory text. Do not include // comments or /* */ style comments in the JSON.

If the required parameters are not found or invalid, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Missing or invalid parameters. Please provide source chain, destination chain, token addresses and amount."
}
\`\`\`

Example valid tokens:
- Ethereum MATIC: 0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0
- Ethereum USDC: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
- Ethereum WETH: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
- Polygon MATIC: 0x0000000000000000000000000000000000001010
- Polygon USDC: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
- Polygon WETH: 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619
- Arbitrum USDC: 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8
- Arbitrum WETH: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1

Always use the appropriate token address for the specified chains.`;

export const proposeGovernanceActionTemplate = `You are an AI assistant. Your task is to extract parameters for submitting a new governance proposal.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- chain: The blockchain name (e.g., "polygon").
- governorAddress: The address of the Governor contract.
- targets: An array of target contract addresses.
- values: An array of ETH values (strings) for each action.
- calldatas: An array of hex-encoded calldata for each action.
- description: The full text description of the proposal.

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "chain": "string",
    "governorAddress": "0xstring",
    "targets": ["0xstring"],
    "values": ["string"],
    "calldatas": ["0xstring"],
    "description": "string"
}
\`\`\`

If any required parameters are missing or unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Could not determine all required governance proposal parameters (chain, governorAddress, targets, values, calldatas, description). Please clarify your request."
}
\`\`\`
`;

export const voteGovernanceActionTemplate = `You are an AI assistant. Your task is to extract parameters for voting on a governance proposal.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- chain: The blockchain name (e.g., "polygon").
- governorAddress: The address of the Governor contract.
- proposalId: The ID of the proposal to vote on.
- support: The vote option (0 for Against, 1 for For, 2 for Abstain).
- reason (optional): The reason for the vote.

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "chain": "string",
    "governorAddress": "0xstring",
    "proposalId": "string",
    "support": number,
    "reason"?: "string"
}
\`\`\`

If any required parameters (chain, governorAddress, proposalId, support) are missing or unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Could not determine all required voting parameters (chain, governorAddress, proposalId, support). Please clarify your request."
}
\`\`\`
`;

export const queueGovernanceActionTemplate = `You are an AI assistant. Your task is to extract parameters for queueing a passed governance proposal.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- chain: The blockchain name (e.g., "polygon").
- governorAddress: The address of the Governor contract.
- targets: An array of target contract addresses.
- values: An array of ETH values (strings) for each action.
- calldatas: An array of hex-encoded calldata for each action.
- description: The full text description of the proposal (must match the original proposal).

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "chain": "string",
    "governorAddress": "0xstring",
    "targets": ["0xstring"],
    "values": ["string"],
    "calldatas": ["0xstring"],
    "description": "string"
}
\`\`\`

If any required parameters are missing or unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Could not determine all parameters for queueing the proposal (chain, governorAddress, targets, values, calldatas, description). Please clarify your request."
}
\`\`\`
`;

export const executeGovernanceActionTemplate = `You are an AI assistant. Your task is to extract parameters for executing a queued governance proposal.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- chain: The blockchain name (e.g., "polygon").
- governorAddress: The address of the Governor contract.
- targets: An array of target contract addresses.
- values: An array of ETH values (strings) for each action.
- calldatas: An array of hex-encoded calldata for each action.
- description: The full text description of the proposal (must match the original proposal).

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "chain": "string",
    "governorAddress": "0xstring",
    "targets": ["0xstring"],
    "values": ["string"],
    "calldatas": ["0xstring"],
    "description": "string"
}
\`\`\`

If any required parameters are missing or unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Could not determine all parameters for executing the proposal (chain, governorAddress, targets, values, calldatas, description). Please clarify your request."
}
\`\`\`
`;

export const getCheckpointStatusTemplate = `You are an AI assistant. Your task is to extract the block number from the user's message to check its checkpoint status.
The block number must be a positive integer.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify the Polygon L2 block number to check.

Respond with a JSON markdown block containing only the extracted block number.
The JSON should have this structure:
\`\`\`json
{
    "blockNumber": number
}
\`\`\`

If no valid block number is found, or if the user's intent is unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Block number not found or invalid. Please specify a positive integer for the block number."
}
\`\`\`
`;

export const isL2BlockCheckpointedTemplate = `You are an AI assistant. Your task is to extract the block number from the user's message to check if it has been checkpointed.
The block number must be a positive integer. Extract the block number from the user's most recent message if multiple messages are provided.
Do not return anything other than the block number requested to be checked in the following json format.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify the Polygon L2 block number to check if it has been checkpointed.

Respond with a JSON markdown block containing only the extracted block number.
The JSON should have this structure:
\`\`\`json
{
    "l2BlockNumber": number
}
\`\`\`

If no valid block number is found, or if the user's intent is unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Block number not found or invalid. Please specify a positive integer for the block number."
}
\`\`\`
`;

// Note: Heimdall transfer tokens template removed as Heimdall does not support general token transfers
// See HEIMDALL_ANALYSIS.md for detailed findings about Heimdall's limitations
