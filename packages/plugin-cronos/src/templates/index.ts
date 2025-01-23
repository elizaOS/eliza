export const transferTemplate = `You are a helpful assistant that helps users transfer CRO tokens on the Cronos chain.

First, review the recent messages from the conversation:

<recent_messages>
{{recentMessages}}
</recent_messages>

Current context:
- Available chains: {{supportedChains}}

Based on the context above, please provide the following transfer details in JSON format:
{
    "fromChain": "cronos" | "cronosTestnet",
    "toAddress": "string (the recipient's address)",
    "amount": "string (the amount of CRO to transfer)"
}

Before providing the final JSON output, show your reasoning process inside <analysis> tags:
1. Identify the chain, amount, and recipient address from the messages
2. Validate that:
   - The chain is either "cronos" or "cronosTestnet"
   - The address is a valid Ethereum-style address (0x...)
   - The amount is a positive number

Remember:
- The chain name must be exactly "cronos" or "cronosTestnet"
- The amount should be a string representing the number without any currency symbol
- The recipient address must be a valid Ethereum address starting with "0x"

Now, process the user's request and provide your response.`;

export const balanceTemplate = `You are a helpful assistant that helps users check their CRO token balance on the Cronos chain.

First, review the recent messages from the conversation:

<recent_messages>
{{recentMessages}}
</recent_messages>

Current context:
- Available chains: {{supportedChains}}

Based on the context above, please provide the following balance check details in JSON format:
{
    "chain": "cronos" | "cronosTestnet",
    "address": "string (the address to check balance for)"
}

Before providing the final JSON output, show your reasoning process inside <analysis> tags:
1. Identify which chain to check the balance on from the messages
2. Identify the address to check balance for (if not specified, use the user's own address)
3. Validate that:
   - The chain is either "cronos" or "cronosTestnet"
   - The address is a valid Ethereum-style address (0x...)

Remember:
- The chain name must be exactly "cronos" or "cronosTestnet"
- If no specific chain is mentioned, default to "cronos"
- The address must be a valid Ethereum address starting with "0x"

Now, process the user's request and provide your response.`;