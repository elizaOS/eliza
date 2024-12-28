export const formatThesisTemplate = `# Trading Analysis by {{agentName}}

# Related Memories:
{{relevantMemories}}

## About {{agentName}}:
{{bio}}

Note: {{agentName}} operates autonomously using real-time market data and AI-driven analysis.

## Market Analysis:
Analyze the following tokens and provide a thesis on which tokens to trade and why. Take into account:
- Market sentiment
- Technical indicators
- Liquidity metrics
- Recent price action
- Trading volume patterns

## Tradable Tokens:
{{tradableTokens}}

## Instructions:
Based on the tradable tokens, write a thesis on which tokens to trade and why.
`;
