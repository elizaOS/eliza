export const getNewCoinsTemplate = `Determine if this is a new coins request. If it is one of the specified situations, perform the corresponding action:

Situation 1: "Get all new coins"
- Message contains: phrases like "all new coins", "all recent listings", "all latest coins"
- Example: "Show me all new coin listings" or "List all recently added coins"
- Action: Return with limit=50

Situation 2: "Get specific number of new coins"
- Message contains: number followed by "new coins" or "latest" followed by number and "coins"
- Example: "Show me 5 new coins" or "Get the latest 20 coins"
- Action: Return with limit=specified number

Situation 3: "Default new coins request"
- Message contains: general phrases like "new coins", "recent listings", "latest coins"
- Example: "What are the newest coins?" or "Show me recent listings"
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