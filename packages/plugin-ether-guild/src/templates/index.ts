export const getBalanceTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested check balance:
- Chain to execute on. (Must be among "ethereum" | "abstract" | "base" | "sepolia" | "bsc" | "arbitrum" | "avalanche" | "polygon" | "optimism" | "cronos" | "gnosis" | "fantom" | "klaytn" | "celo" | "moonbeam" | "aurora" | "harmonyOne" | "moonriver" | "arbitrumNova" | "mantle" | "linea" | "scroll" | "filecoin" | "taiko" | "zksync" | "canto" | "alienx" | null)
- Address to check balance for. Optional, must be a valid Ethereum address starting with "0x" or a web3 domain name. If not provided, use the BNB chain Wallet Address.
- Token symbol or address. Could be a token symbol or address. If the address is provided, it must be a valid Ethereum address starting with "0x". Default is "ETH" which does not have an address. WETH might have address on chains other than ethereum mainnet Try to get the token contract address from the chain.
If any field is not provided, use the default value. If no default value is specified, use null.

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined:

\`\`\`json
{
    "chain": SUPPORTED_CHAINS,
    "address": string | null,
    "token": string
}
\`\`\`
`;

export const transferTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested transfer:
- Chain to execute on. (Must be among "ethereum" | "abstract" | "base" | "sepolia" | "bsc" | "arbitrum" | "avalanche" | "polygon" | "optimism" | "cronos" | "gnosis" | "fantom" | "klaytn" | "celo" | "moonbeam" | "aurora" | "harmonyOne" | "moonriver" | "arbitrumNova" | "mantle" | "linea" | "scroll" | "filecoin" | "taiko" | "zksync" | "canto" | "alienx" | null)
- Token symbol or address. Could be a token symbol or address. If the address is provided, it must be a valid Ethereum address starting with "0x". Default is "ETH" which is native token for Ethereum, also BNB which native to Bsc chain. WETH might have address on chains other than ethereum mainnet Try to get the token contract address from the chain.
- Amount to transfer. Optional. Must be a string representing the amount in ether (only number without coin symbol, e.g., "0.1").
- Recipient address. Must be a valid Ethereum address starting with "0x" or a web3 domain name.
- Data. Optional, data to be included in the transaction. If not provided, use "0x".
If any field is not provided, use the default value. If no default value is specified, use null.

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined:

\`\`\`json
{
    "chain": SUPPORTED_CHAINS,
    "token": string | null,
    "amount": string | null,
    "toAddress": string,
    "data": string | null
}
\`\`\`
`;

export const swapTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested token swap:
- Chain to execute on. (Must be among "ethereum" | "abstract" | "base" | "sepolia" | "bsc" | "arbitrum" | "avalanche" | "polygon" | "optimism" | "cronos" | "gnosis" | "fantom" | "klaytn" | "celo" | "moonbeam" | "aurora" | "harmonyOne" | "moonriver" | "arbitrumNova" | "mantle" | "linea" | "scroll" | "filecoin" | "taiko" | "zksync" | "canto" | "alienx" | null)
- Input token symbol or address(string starting with "0x"). Could be a token symbol or address. Try to get the token contract address if token symbol is provided from the chain.  Default is "ETH" for Ethereum, and "BNB" for Bsc chain.
- Output token symbol or address(string starting with "0x"). Could be a token symbol or address. Try to get the token contract address if token symbol is provided from the chain.  Default is "ETH" for Ethereum, and "BNB" for Bsc chain.
- Amount to swap. Must be a string representing the amount in ether (only number without coin symbol, e.g., "0.1").
- Slippage. Optional, expressed as decimal proportion, 0.03 represents 3%.
If any field is not provided, use the default value. If no default value is specified, use null.

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined:

\`\`\`json
{
    "chain": SUPPORTED_CHAINS,
    "inputToken": string | null,
    "outputToken": string | null,
    "amount": string | null,
    "slippage": number | null
}
\`\`\`
`;


export const ercContractTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

When user wants to deploy any type of token contract (ERC20/721/1155), this will trigger the DEPLOY_TOKEN action.

Extract the following details for deploying a token contract:
- Chain to execute on. (Must be among "ethereum" | "abstract" | "base" | "sepolia" | "bsc" | "arbitrum" | "avalanche" | "polygon" | "optimism" | "cronos" | "gnosis" | "fantom" | "klaytn" | "celo" | "moonbeam" | "aurora" | "harmonyOne" | "moonriver" | "arbitrumNova" | "mantle" | "linea" | "scroll" | "filecoin" | "taiko" | "zksync" | "canto" | "alienx" | null)
- contractType: The type of token contract to deploy
  - For ERC20: Extract name, symbol, decimals, totalSupply
  - For ERC721: Extract name, symbol, baseURI
  - For ERC1155: Extract name, baseURI
- name: The name of the token.
- symbol: The token symbol (only for ERC20/721).
- decimals: Token decimals (only for ERC20). Default is 18.
- totalSupply: Total supply with decimals (only for ERC20). Default is "1000000000000000000".
- baseURI: Base URI for token metadata (only for ERC721/1155).
If any field is not provided, use the default value. If no default value is provided, use empty string.

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined:

\`\`\`json
{
    "chain": SUPPORTED_CHAINS,
    "contractType": "ERC20" | "ERC721" | "ERC1155",
    "name": string,
    "symbol": string | null,
    "decimals": number | null,
    "totalSupply": string | null,
    "baseURI": string | null
}
\`\`\`
`;
