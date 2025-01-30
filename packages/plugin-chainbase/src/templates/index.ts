export const responsePrompt = (
    result: any,
    query: string
) => `You are a blockchain data analyst. Your task is to analyze and present the query results from Chainbase in a clear and informative way.

SQL Query:"""
${result.sql}
"""

Query Results:"""
${JSON.stringify(
    {
        columns: result.columns,
        data: result.data,
        totalRows: result.totalRows,
    },
    null,
    2
)}
"""

User's Query:"""
${query}
"""

Instructions:
1. **Format the Response**: Present the results in a structured format with emojis for better readability:
   - 📊 Query Results (with user's original query)
   - 🔍 SQL Query used
   - 📋 Data in table format
   - 📈 Brief analysis of the results

2. **Data Presentation**:
   - Format numbers with appropriate commas and decimals
   - Present data in a clean table format using | for columns
   - Highlight key metrics and trends

3. **Analysis**:
   - Provide a brief, clear analysis of what the data shows
   - Focus on the most relevant insights related to the user's query
   - Use simple, non-technical language when possible

Format your response following this example:
📊 Query Results for: [user's query]

🔍 SQL Query:
[SQL query used]

📋 Data:
| Column1 | Column2 |
| Value1 | Value2 |

📈 Analysis: [Brief analysis of the results]

Remember:
- Keep the response concise and focused
- Format numbers for readability
- Highlight key insights
- Relate the analysis back to the user's original query`;

export const retrieveTokenBalanceTemplate = `
Extract query parameters for fetching all erc20 token balance for a wallet address:
- **address** (string, required): The address of the wallet to which the api queries.
- **chain_id** (string, optional): Specify The chain on which token bases.
- **contract_address** (string, optional): Specify one token contract address to check of.

Supported chains and their chain IDs:
- Ethereum (chain_id: "1")
- Polygon (chain_id: "137")
- BSC (chain_id: "56")
- Avalanche (chain_id: "43114")
- Arbitrum One (chain_id: "42161")
- Optimism (chain_id: "10")
- Base (chain_id: "8453")
- zkSync (chain_id: "324")
- Merlin (chain_id: "4200")

Provide the details in the following JSON format:
\`\`\`json
{
    "address": "<string>",
    "chain_id"?: "<string>",
    "contract_address"?: "<string>",
}
\`\`\`

Example for reading the balance of an ERC20 token:
\`\`\`json
{
    "address": "0xaC21F9e3550E525e568aC47Bc08095e7606c8B3F",
    "chain_id": "1",
    "contract_address"?: "0xdac17f958d2ee523a2206206994597c13d831ec7",
}
\`\`\`

Example for reading the balance of all ERC20 tokens on evm mainnet:
\`\`\`json
{
    "address": "0xaC21F9e3550E525e568aC47Bc08095e7606c8B3F",
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;

export const formatTokenBalancePrompt = (tokens: any[], address: string) => `
You are a blockchain data analyst. Format the following token balance data in a clear and readable way.
Show the token balances for address ${address}.

Token data:
${JSON.stringify(tokens, null, 2)}

Format the response to be concise but informative. Include:
- A brief summary line
- List each token with its balance, symbol and USD value if available
- Use appropriate emojis and formatting
`;
