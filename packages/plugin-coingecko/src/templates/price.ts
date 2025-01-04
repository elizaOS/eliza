export const getPriceTemplate = `Given the message, extract information about the cryptocurrency price check request. Look for coin name/symbol and currency.

Common coin mappings:
- BTC/Bitcoin -> "bitcoin"
- ETH/Ethereum -> "ethereum"
- USDC -> "usd-coin"

Format the response as a JSON object with these fields:
- coinId: the normalized coin ID (e.g., "bitcoin", "ethereum", "usd-coin")
- currency: the currency for price (default to "usd" if not specified)

Example responses:
For "What's the price of Bitcoin?":
\`\`\`json
{
    "coinId": "bitcoin",
    "currency": "usd"
}
\`\`\`

For "Check ETH price in EUR":
\`\`\`json
{
    "coinId": "ethereum",
    "currency": "eur"
}
\`\`\`

{{recentMessages}}

Extract the cryptocurrency and currency information from the above messages and respond with the appropriate JSON.`;
