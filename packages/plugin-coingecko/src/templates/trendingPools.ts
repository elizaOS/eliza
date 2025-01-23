export const getTrendingPoolsTemplate = `Determine if this is a trending pools request. If it is one of the specified situations, perform the corresponding action:

Situation 1: "Get all trending pools"
- Message contains: phrases like "all trending pools", "show all pools", "list all pools"
- Example: "Show me all trending pools" or "List all pools"
- Action: Return with limit=100

Situation 2: "Get specific number of pools"
- Message contains: number followed by "pools" or "top" followed by number and "pools"
- Example: "Show top 5 pools" or "Get me 20 trending pools"
- Action: Return with limit=specified number

Situation 3: "Default trending pools request"
- Message contains: general phrases like "trending pools", "hot pools", "popular pools"
- Example: "What are the trending pools?" or "Show me hot pools"
- Action: Return with limit=10

For all situations, respond with a JSON object in the format:
\`\`\`json
{
    "limit": number
}
\`\`\`

Previous conversation for context:
{{conversation}}

You are replying to: {{message}}
`;