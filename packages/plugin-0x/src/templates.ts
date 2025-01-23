export const getIndicativePriceTemplate = `
    You are helping users get indicative prices for token swaps across different chains.

    Extract the following information:
    - sellToken: The token the user wants to sell (e.g., ETH, WETH, USDC)
    - buyToken: The token the user wants to receive (e.g., USDC, WETH, USDT)
    - sellAmount: The amount of tokens to sell (numeric value only)
    - chain: The blockchain network for the swap (e.g., ethereum, optimism, arbitrum, base)

    Return in JSON format:
    {
        "sellTokenSymbol": "<token symbol>",
        "buyTokenSymbol": "<token symbol>",
        "sellAmount": "<amount as string>"
        "chain": {{supportedChains}}
    }

    Examples:
    "What's the price of 2 ETH in USDC on Optimism?"
    {
        sellTokenSymbol: "ETH",
        buyTokenSymbol: "USDC",
        sellAmount: 2,
        chain: "optimism"
    }

    "I want to swap 1000 USDC to WETH on Base"
    {
        sellTokenSymbol: "USDC",
        buyTokenSymbol: "WETH",
        sellAmount: 1000,
        chain: "base"
    }

    Notes:
    - If the chain is not specified, assume it's "ethereum".
    - If you are unsure, just return null for the missing fields.

    Recent conversation:
    {{recentMessages}}
`;

export const getQuoteTemplate = `Look at the recent conversation and extract the quote details.

Extract:
- Which token the user wants to sell (sellToken)
- Which token the user wants to buy (buyToken)
- How much they want to sell (sellAmount) If amount is not specified, return null for sellAmount

For example:
"I want to convert 5 WETH to USDC" -> { "sellToken": "WETH", "buyToken": "USDC", "sellAmount": "5" }
"Convert 100 LINK to USDC" -> { "sellToken": "LINK", "buyToken": "USDC", "sellAmount": "100" }
"How much DAI can I get for 100 USDC?" -> { "sellToken": "USDC", "buyToken": "DAI", "sellAmount": "100" }
"WETH/USDT price?" -> { "sellToken": "WETH", "buyToken": "USDT", "sellAmount": null }

Return in JSON format:
{
    "sellToken": "<token symbol>",
    "buyToken": "<token symbol>",
    "sellAmount": "<amount as string>"
}

Recent conversation:
{{recentMessages}}`;
