export const blockDetailsByNumberTemplate = `You are an AI assistant. Your task is to extract the block number from the user's message.
The block number must be a positive integer.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify the block number.

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

export const blockDetailsByHashTemplate = `You are an AI assistant. Your task is to extract the block hash from the user's message.
The block hash must be a valid hexadecimal string starting with '0x'.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify the block hash.

Respond with a JSON markdown block containing only the extracted block hash.
The JSON should have this structure:
\`\`\`json
{
    "blockHash": string
}
\`\`\`

If no valid block hash is found, or if the user's intent is unclear, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Block hash not found or invalid. Please specify a valid hexadecimal block hash starting with '0x'."
}
\`\`\`
`;

export const checkBlockStatusTemplate = `You are an AI assistant. Your task is to extract block identifier (number or hash) from the user's message for checking block status.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- blockNumber: A positive integer block number (if specified)
- blockHash: A valid hexadecimal block hash starting with '0x' (if specified)

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "blockNumber"?: number,
    "blockHash"?: string
}
\`\`\`

If no valid block identifier is found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Block identifier not found. Please specify either a block number (positive integer) or block hash (0x...)."
}
\`\`\`
`;

export const estimateGasTemplate = `You are an AI assistant. Your task is to extract transaction parameters for gas estimation.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- to: The recipient address (0x...)
- from: The sender address (0x...) - optional
- value: The ETH value to send (e.g., "1.5", "0.1") - optional
- data: The transaction data (0x...) - optional

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "to"?: string,
    "from"?: string,
    "value"?: string,
    "data"?: string
}
\`\`\`

If no valid transaction parameters are found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Transaction parameters not found. Please specify at least a recipient address for gas estimation."
}
\`\`\`
`;

export const estimateTransactionFeeTemplate = `You are an AI assistant. Your task is to extract transaction parameters for fee estimation.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- to: The recipient address (0x...)
- from: The sender address (0x...) - optional
- value: The ETH value to send (e.g., "1.5", "0.1") - optional
- data: The transaction data (0x...) - optional
- priorityFee: Custom priority fee in Gwei (e.g., "2", "1.5") - optional
- gasPrice: Custom gas price in Gwei (e.g., "20", "15.5") - optional
- rawTransaction: Raw transaction hex string (0x...) - optional

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "to"?: string,
    "from"?: string,
    "value"?: string,
    "data"?: string,
    "priorityFee"?: string,
    "gasPrice"?: string,
    "rawTransaction"?: string
}
\`\`\`

If no valid transaction parameters are found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Transaction parameters not found. Please specify at least a recipient address or raw transaction for fee estimation."
}
\`\`\`
`;

export const getAccountBalanceTemplate = `You are an AI assistant. Your task is to extract account address from the user's message for balance checking.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- address: The account address (0x...)

Respond with a JSON markdown block containing only the extracted address.
The JSON should have this structure:
\`\`\`json
{
    "address": string
}
\`\`\`

If no valid address is found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Account address not found. Please specify a valid Ethereum address (0x...)."
}
\`\`\`
`;

export const getBalanceTemplate = `You are an AI assistant. Your task is to extract account address from the user's message for balance checking.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- address: The account address (0x...)

Respond with a JSON markdown block containing only the extracted address.
The JSON should have this structure:
\`\`\`json
{
    "address": string
}
\`\`\`

If no valid address is found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Account address not found. Please specify a valid Ethereum address (0x...)."
}
\`\`\`
`;

export const getBatchInfoTemplate = `You are an AI assistant. Your task is to extract batch identifier from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- batchNumber: A positive integer batch number

Respond with a JSON markdown block containing only the extracted batch number.
The JSON should have this structure:
\`\`\`json
{
    "batchNumber": number
}
\`\`\`

If no valid batch number is found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Batch number not found. Please specify a valid positive integer for the batch number."
}
\`\`\`
`;

export const getCodeTemplate = `You are an AI assistant. Your task is to extract contract address from the user's message for code retrieval.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- address: The contract address (0x...)

Respond with a JSON markdown block containing only the extracted address.
The JSON should have this structure:
\`\`\`json
{
    "address": string
}
\`\`\`

If no valid address is found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Contract address not found. Please specify a valid contract address (0x...)."
}
\`\`\`
`;

export const getLogsTemplate = `You are an AI assistant. Your task is to extract log filter parameters from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- address: The contract address to filter logs from (0x...) - optional
- fromBlock: Starting block number or "latest"/"earliest" - optional
- toBlock: Ending block number or "latest"/"earliest" - optional
- topics: Array of topic filters (0x...) - optional

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "address"?: string,
    "fromBlock"?: string | number,
    "toBlock"?: string | number,
    "topics"?: string[]
}
\`\`\`

If no valid parameters are found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Log filter parameters not found. Please specify at least one filter parameter."
}
\`\`\`
`;

export const getStorageAtTemplate = `You are an AI assistant. Your task is to extract storage parameters from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- address: The contract address (0x...)
- position: The storage position (number or hex string)
- blockTag: The block tag ("latest", "earliest", or block number) - optional, defaults to "latest"

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "address": string,
    "position": string | number,
    "blockTag"?: string | number
}
\`\`\`

If required parameters are not found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Storage parameters not found. Please specify contract address and storage position."
}
\`\`\`
`;

export const getTransactionByHashTemplate = `You are an AI assistant. Your task is to extract transaction hash from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- transactionHash: The transaction hash (0x... 64 characters)

Respond with a JSON markdown block containing only the extracted transaction hash.
The JSON should have this structure:
\`\`\`json
{
    "transactionHash": string
}
\`\`\`

If no valid transaction hash is found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Transaction hash not found. Please specify a valid transaction hash (0x... 64 characters)."
}
\`\`\`
`;

export const getTransactionCountTemplate = `You are an AI assistant. Your task is to extract account address from the user's message for transaction count.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- address: The account address (0x...)
- blockTag: The block tag ("latest", "earliest", or block number) - optional, defaults to "latest"

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "address": string,
    "blockTag"?: string | number
}
\`\`\`

If no valid address is found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Account address not found. Please specify a valid Ethereum address (0x...)."
}
\`\`\`
`;

export const getTransactionDetailsTemplate = `You are an AI assistant. Your task is to extract transaction hash from the user's message for detailed transaction information.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- transactionHash: The transaction hash (0x... 64 characters)

Respond with a JSON markdown block containing only the extracted transaction hash.
The JSON should have this structure:
\`\`\`json
{
    "transactionHash": string
}
\`\`\`

If no valid transaction hash is found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Transaction hash not found. Please specify a valid transaction hash (0x... 64 characters)."
}
\`\`\`
`;

export const getTransactionReceiptTemplate = `You are an AI assistant. Your task is to extract transaction hash from the user's message for transaction receipt.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- transactionHash: The transaction hash (0x... 64 characters)

Respond with a JSON markdown block containing only the extracted transaction hash.
The JSON should have this structure:
\`\`\`json
{
    "transactionHash": string
}
\`\`\`

If no valid transaction hash is found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Transaction hash not found. Please specify a valid transaction hash (0x... 64 characters)."
}
\`\`\`
`;

export const getCurrentBlockNumberTemplate = `You are an AI assistant. Your task is to determine if the user is asking for the current block number on Polygon zkEVM.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, determine if the user is asking for current block information on Polygon zkEVM.

Respond with a JSON markdown block:
\`\`\`json
{
    "requestCurrentBlock": true
}
\`\`\`

If the request is not about getting current block number, you MUST respond with:
\`\`\`json
{
    "error": "Request is not about getting current block number."
}
\`\`\`
`;

export const getGasPriceTemplate = `You are an AI assistant. Your task is to determine if the user is asking for gas price information on Polygon zkEVM.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, determine if the user is asking for gas price information.

Respond with a JSON markdown block:
\`\`\`json
{
    "requestGasPrice": true
}
\`\`\`

If the request is not about getting gas price, you MUST respond with:
\`\`\`json
{
    "error": "Request is not about getting gas price."
}
\`\`\`
`;

export const getGasPriceEstimatesTemplate = `You are an AI assistant. Your task is to determine if the user is asking for gas price estimates on Polygon zkEVM.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, determine if the user is asking for gas price estimates or fee information.

Respond with a JSON markdown block:
\`\`\`json
{
    "requestGasPriceEstimates": true
}
\`\`\`

If the request is not about getting gas price estimates, you MUST respond with:
\`\`\`json
{
    "error": "Request is not about getting gas price estimates."
}
\`\`\`
`;

export const deploySmartContractTemplate = `You are an AI assistant. Your task is to extract smart contract deployment parameters from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- bytecode: The contract bytecode (0x...) - required
- constructorArgs: Array of constructor arguments - optional
- gasLimit: Gas limit for deployment - optional
- gasPrice: Gas price in gwei - optional
- maxFeePerGas: Maximum fee per gas in gwei (EIP-1559) - optional
- maxPriorityFeePerGas: Maximum priority fee per gas in gwei (EIP-1559) - optional
- value: ETH value to send with deployment (in ETH, e.g., "0.1") - optional

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "bytecode": string,
    "constructorArgs"?: any[],
    "gasLimit"?: string | number,
    "gasPrice"?: string,
    "maxFeePerGas"?: string,
    "maxPriorityFeePerGas"?: string,
    "value"?: string
}
\`\`\`

If no valid bytecode is found, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Contract bytecode not found. Please specify valid contract bytecode starting with '0x'."
}
\`\`\`
`;

export const bridgeAssetsTemplate = `You are an AI assistant. Your task is to extract bridge asset parameters from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- tokenAddress: The token contract address (0x...) - use null for ETH - required
- amount: The amount to bridge (e.g., "1.5", "100") - required
- direction: The bridge direction ("deposit" for L1->L2, "withdraw" for L2->L1) - required
- gasLimit: Gas limit for the transaction - optional
- gasPrice: Gas price in gwei - optional
- maxFeePerGas: Maximum fee per gas in gwei (EIP-1559) - optional
- maxPriorityFeePerGas: Maximum priority fee per gas in gwei (EIP-1559) - optional

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "tokenAddress": string | null,
    "amount": string,
    "direction": "deposit" | "withdraw",
    "gasLimit"?: string | number,
    "gasPrice"?: string,
    "maxFeePerGas"?: string,
    "maxPriorityFeePerGas"?: string
}
\`\`\`

If required parameters are missing, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Bridge parameters not found. Please specify token address (or null for ETH), amount, and direction (deposit/withdraw)."
}
\`\`\`
`;

export const bridgeMessagesTemplate = `You are an AI assistant. Your task is to extract bridge message parameters from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- destinationChain: The destination chain ("ethereum" for L1 or "zkevm" for L2) - required
- messageData: The arbitrary calldata/message data (0x...) - required
- gasLimit: Gas limit for the transaction - optional
- gasPrice: Gas price in gwei - optional
- maxFeePerGas: Maximum fee per gas in gwei (EIP-1559) - optional
- maxPriorityFeePerGas: Maximum priority fee per gas in gwei (EIP-1559) - optional
- value: ETH value to send with message (in ETH, e.g., "0.1") - optional

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "destinationChain": "ethereum" | "zkevm",
    "messageData": string,
    "gasLimit"?: string | number,
    "gasPrice"?: string,
    "maxFeePerGas"?: string,
    "maxPriorityFeePerGas"?: string,
    "value"?: string
}
\`\`\`

If required parameters are missing, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Bridge message parameters not found. Please specify destination chain (ethereum/zkevm) and message data (0x...)."
}
\`\`\`
`;

export const interactSmartContractTemplate = `You are an AI assistant. Your task is to extract smart contract interaction parameters from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- contractAddress: The smart contract address (0x...) - required
- abi: The contract ABI (JSON array) - required
- methodName: The contract method/function name to call - required
- args: Array of arguments for the method call - optional (empty array if no args)
- gasLimit: Gas limit for the transaction - optional
- gasPrice: Gas price in gwei - optional
- maxFeePerGas: Maximum fee per gas in gwei (EIP-1559) - optional
- maxPriorityFeePerGas: Maximum priority fee per gas in gwei (EIP-1559) - optional
- value: ETH value to send with transaction (in ETH, e.g., "0.1") - optional

Respond with a JSON markdown block containing only the extracted values.
The JSON should have this structure:
\`\`\`json
{
    "contractAddress": string,
    "abi": any[],
    "methodName": string,
    "args"?: any[],
    "gasLimit"?: string | number,
    "gasPrice"?: string,
    "maxFeePerGas"?: string,
    "maxPriorityFeePerGas"?: string,
    "value"?: string
}
\`\`\`

If required parameters are missing, you MUST respond with the following JSON structure:
\`\`\`json
{
    "error": "Smart contract interaction parameters not found. Please specify contract address, ABI, and method name."
}
\`\`\`
`;
