export const swapTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined:

Here are several frequently used addresses. Use these for the corresponding tokens:
- ZK/zk: 0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E
- ETH/eth: 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
- USDC/usdc: 0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4
- HOLD/hold: 0xed4040fD47629e7c8FBB7DA76bb50B3e7695F0f2

Example response:
\`\`\`json
{
    "inputTokenSymbol": "USDC",
    "outputTokenSymbol": "HOLD",
    "inputTokenCA": "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4",
    "outputTokenCA": "0xed4040fD47629e7c8FBB7DA76bb50B3e7695F0f2",
    "amount": "100",
    "slippage": "0.005"
}
\`\`\`

{{recentMessages}}

Given the recent messages and wallet information below:

{{account}}

Extract the following information about the requested token swap:
- Input token symbol (the token being sold)
- Output token symbol (the token being bought)
- Input token contract address
- Output token contract address
- Amount to swap
- Slippage tolerance (optional, default 0.005 if not specified)

**Validation Details**:
1. **Amount**:
   - Verify the amount is a valid numeric string.

2. **Input and Output Tokens**:
   - Verify that atleast one of the symbol or contract address is provided for both input and output tokens.

3. **Slippage**:
   - If the user does not specify, use the default value of 0.5%.

**Example Scenarios**:
1. User says, "Swap 1 HOLD for ETH":
   - Input token symbol: HOLD
   - Output token symbol: ETH
   - Input token contract address: null
   - Output token contract address: null
   - Amount to swap: 1
   - Slippage: null (default will apply)

2. User says, "Swap 4 USDC to HOLD (0xed4040fD47629e7c8FBB7DA76bb50B3e7695F0f2) with 1% slippage":
   - Input token symbol: USDC
   - Output token symbol: HOLD
   - Input token contract address: null
   - Output token contract address: 0xed4040fD47629e7c8FBB7DA76bb50B3e7695F0f2
   - Amount to swap: 4
   - Slippage: 0.01

3. User says, "Swap 1 token CA 0xed4040fD47629e7c8FBB7DA76bb50B3e7695F0f2 to USDC with 0.5% slippage":
    - Input token symbol: null
    - Output token symbol: USDC
    - Input token contract address: 0xed4040fD47629e7c8FBB7DA76bb50B3e7695F0f2
    - Output token contract address: null
    - Amount to swap: 1
    - Slippage: 0.005

Now, process the user's request and provide the JSON response.`;
