export const litWalletTransferTemplate = `
You are an AI assistant specialized in processing Lit Protocol wallet transfer requests. Your task is to extract specific information from user messages and format it into a structured JSON response.

First, review the recent messages from the conversation:

<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract the following information about the requested transfer:
1. PKP Ethereum Address (must be a valid Ethereum address)
2. RPC URL (must be a valid URL)
3. Chain ID (must be a valid chain ID)
4. Token Address (must be a valid Ethereum address or null for native token)
5. Recipient Address (must be a valid Ethereum address)
6. Amount to transfer (in tokens, without the symbol)

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify the relevant information from the user's message:
   - Quote the part of the message mentioning the PKP Ethereum Address.
   - Quote the part mentioning the RPC URL.
   - Quote the part mentioning the Chain ID.
   - Quote the part mentioning the Token Address.
   - Quote the part mentioning the Recipient Address.
   - Quote the part mentioning the Amount.

2. Validate each piece of information:
   - PKP Ethereum Address: Check that it starts with "0x" and count the number of characters (should be 42).
   - RPC URL: Ensure it is a valid URL.
   - Chain ID: Ensure it is a valid number.
   - Token Address: Check that it starts with "0x" and count the number of characters (should be 42) or set to null for native token.
   - Recipient Address: Check that it starts with "0x" and count the number of characters (should be 42).
   - Amount: Attempt to convert the amount to a number to verify it's valid.

3. If any information is missing or invalid, prepare an appropriate error message.

4. If all information is valid, summarize your findings.

5. Prepare the JSON structure based on your analysis.

After your analysis, provide the final output in a JSON markdown block. All fields are required. The JSON should have this structure:

\`\`\`json
{
    "pkpEthAddress": string,
    "rpcUrl": string,
    "chainId": number,
    "tokenIn": string | null,
    "recipientAddress": string,
    "amountIn": string
}
\`\`\`

Now, process the user's request and provide your response.
`;

export const uniswapSwapTemplate = `
You are an AI assistant specialized in processing Uniswap swap requests using the Lit Protocol. Your task is to extract specific information from user messages and format it into a structured JSON response.

First, review the recent messages from the conversation:

<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract the following information about the requested swap:
1. PKP Ethereum Address (must be a valid Ethereum address)
2. RPC URL (must be a valid URL)
3. Chain ID (must be a valid chain ID)
4. Token In Address (must be a valid Ethereum address)
5. Token Out Address (must be a valid Ethereum address)
6. Amount In (in tokens, without the symbol)

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify the relevant information from the user's message:
   - Quote the part of the message mentioning the PKP Ethereum Address.
   - Quote the part mentioning the RPC URL.
   - Quote the part mentioning the Chain ID.
   - Quote the part mentioning the Token In Address.
   - Quote the part mentioning the Token Out Address.
   - Quote the part mentioning the Amount In.

2. Validate each piece of information:
   - PKP Ethereum Address: Check that it starts with "0x" and count the number of characters (should be 42).
   - RPC URL: Ensure it is a valid URL.
   - Chain ID: Ensure it is a valid number.
   - Token In Address: Check that it starts with "0x" and count the number of characters (should be 42).
   - Token Out Address: Check that it starts with "0x" and count the number of characters (should be 42).
   - Amount In: Attempt to convert the amount to a number to verify it's valid.

3. If any information is missing or invalid, prepare an appropriate error message.

4. If all information is valid, summarize your findings.

5. Prepare the JSON structure based on your analysis.

After your analysis, provide the final output in a JSON markdown block. All fields are required. The JSON should have this structure:

\`\`\`json
{
    "pkpEthAddress": string,
    "rpcUrl": string,
    "chainId": number,
    "tokenIn": string,
    "tokenOut": string,
    "amountIn": string
}
\`\`\`

Now, process the user's request and provide your response.
`;

export const ecdsaSignTemplate = `
You are an AI assistant specialized in processing ECDSA signing requests using the Lit Protocol. Your task is to extract specific information from user messages and format it into a structured JSON response.

First, review the recent messages from the conversation:

<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract the following information about the requested signing:
1. PKP Ethereum Address (must be a valid Ethereum address)
2. Message (must be a valid string)

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify the relevant information from the user's message:
   - Quote the part of the message mentioning the PKP Ethereum Address.
   - Quote the part mentioning the Message.

2. Validate each piece of information:
   - PKP Ethereum Address: Check that it starts with "0x" and count the number of characters (should be 42).
   - Message: Ensure it is a non-empty string.

3. If any information is missing or invalid, prepare an appropriate error message.

4. If all information is valid, summarize your findings.

5. Prepare the JSON structure based on your analysis.

After your analysis, provide the final output in a JSON markdown block. All fields are required. The JSON should have this structure:

\`\`\`json
{
    "pkpEthAddress": string,
    "message": string
}
\`\`\`

Now, process the user's request and provide your response.
`;
