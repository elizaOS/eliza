import { Strategy } from "../services/levva/pool";
import { DataDescription, formatKeys, formatOutput } from "./util";

/** */
export interface ExtractedDataForStrategy {
  strategy?: Strategy;
  contract?: `0x${string}`;
  token?: string;
  amount?: `${number}`;
  leverage?: number;
}

const dataDescription: DataDescription<ExtractedDataForStrategy> = {
  strategy: {
    type: "string",
    description:
      'The strategy risk profile to use, one of: "ultra-safe", "safe", "brave", "custom"',
  },
  contract: {
    type: "string",
    description: "The address of the contract to use for the strategy",
  },
  token: {
    type: "string",
    description: "The token to deposit, can be either symbol or address",
  },
  amount: {
    type: "string",
    description:
      "The amount of tokens to deposit, denominated in token to be sent",
  },
  leverage: {
    type: "number",
    description: "The leverage to use for the transaction",
    default: "5",
  },
};

export const selectStrategyDataFromMessagesPrompt = (ctx: {
  pools: string;
  knownTokens: string;
  portfolio: string;
  recentMessages: string;
}) => `<task>
Extract data for next transaction from recent messages.
</task>
<pools>
${ctx.pools}
</pools>
<knownTokens>
${ctx.knownTokens}
</knownTokens>
<portfolio>
${ctx.portfolio}
</portfolio>
<recentMessages>
${ctx.recentMessages}
</recentMessages>
<instructions>
Ignore messages for transactions that are either canceled or confirmed.
Provided info in "pools", "knownTokens" and "portfolio" should NOT be used to fill a value in not provided by user in messages.
User can deposit any token in any pool.
Also include thought in output.
</instructions>
<keys>
${formatKeys({ ...dataDescription, thought: { type: "string", description: "Thoughts about the data" } })}
</keys>
<output>
${formatOutput({ ...dataDescription, thought: { type: "string", description: "Thoughts about the data" } })}
</output>`;

export const suggestStrategyRiskProfilePrompt = (ctx: {
  decision: object;
  conversation: string;
  strategies: string;
  portfolio: string;
  availableTokens: string;
}) => `<task>
Generate suggestions for strategy risk profile, given user's portfolio and available tokens
</task>
<decision>
${JSON.stringify(ctx.decision)}
</decision>
<conversation>
${ctx.conversation}
</conversation>
<strategies>
Strategies by risk profile:
${ctx.strategies}
</strategies>
<portfolio>
User has following tokens available in portfolio:
${ctx.portfolio}
</portfolio>
<availableTokens>
Tokens known to agent:
${ctx.availableTokens}
</availableTokens>
<instructions>
Generate suggestions for strategy risk profile.
Include brief description in "label".
"text" should include strategy risk profile name and if there is one more strategy - its contract address
</instructions>
<keys>
- "suggestions" should be an array of objects with the following keys:
  - "label"
  - "text"
</keys>
<output>
Respond using JSON format like in example:
{
  "suggestions": [
    {
      "label": "Ultra-safe",
      "text": "I want to use ultra-safe strategy",
    }, ...
    ]
}
`;

export const suggestStrategyContractPrompt = (ctx: {
  pools: string;
  decision: object;
  conversation: string;
  portfolio: string;
  availableTokens: string;
}) => `<task>
Generate suggestions for exchange pairs, given user's portfolio and available tokens
</task>
<decision>
${JSON.stringify(ctx.decision)}
</decision>
<conversation>
${ctx.conversation}
</conversation>
<strategies>
Strategies by risk profile:
${ctx.pools}
</strategies>
<portfolio>
User has following tokens available in portfolio:
${ctx.portfolio}
</portfolio>
<availableTokens>
Tokens known to agent:
${ctx.availableTokens}
</availableTokens>
<instructions>
Generate suggestions for pool selection.
Include brief description in "label".
"text" should include pool address.
</instructions>
<keys>
- "suggestions" should be an array of objects with the following keys:
  - "label"
  - "text"
</keys>
<output>
Respond using JSON format like this:
{
  "suggestions": [
    {
      "label": "PT-weETH - weETH, expiry 25 Jun 2026, APR 13.37%",
      "text": "I choose pool with address 0x4F890EE86aabc87F915282341552aB6F781E5B3a",
    },
    {
      "label": "USDT - ARB, APR 1.94%",
      "text": "I choose pool with address 0x0000000000000000000000000000000000000001",
    } 
   ]
}

Your response should include the valid JSON block and nothing else.
</output>`;

export const suggestStrategyAssetPrompt = (ctx: {
  pools: string;
  decision: object;
  conversation: string;
  portfolio: string;
  availableTokens: string;
}) => `<task>
Generate suggestions for asset selection, given user's portfolio and available tokens
</task>
<decision>
${JSON.stringify(ctx.decision)}
</decision>
<conversation>
${ctx.conversation}
</conversation>
<strategies>
Strategies by risk profile:
${ctx.pools}
</strategies>
<portfolio>
User has following tokens available in portfolio:
${ctx.portfolio}
</portfolio>
<availableTokens>
Tokens known to agent:
${ctx.availableTokens}
</availableTokens>
<instructions>
Generate up to 5 suggestions for asset selection.
In case of "vault" strategy, suggest swap, eg. { "label": "Swap ETH(0.32 available) -> USDC", "text": "I want to Swap ETH to USDC" }
In case of "pool" strategy, suggest deposit, eg. { "label": "Deposit USDT(486.36 available)", "text": "I want to deposit USDT" }
"label" should display token symbol and balance if greater than 0, example: "ETH(0.32 available)" - with balance, "USDC" - without balance
"text" should include token symbol
IMPORTANT ORDERING RULES:
- First prefer tokens with higher balance in portfolio
- Second include base token of pool
- Tokens with no balance should be included afterwards
</instructions>
<keys>
- "suggestions" should be an array of objects with the following keys:
  - "label"
  - "text"
</keys>
<output>
Respond using JSON format like in example:
{
  "suggestions": [
    {
      "label": "ETH(0.32 available",
      "text": "I want to deposit ETH",
    },
    {
      "label": "USDT(217 available)"
      "text": "Deposit USDT",
    },
    {
      "label": "PT-weETH-20JUN2026",
      "text": "I want to deposit PT-weETH-20JUN2026",
    },
    { 
      "label": "USDC",
      "text": "Deposit USDC",
    },
    {
      "label": "DAI",
      "text": "Please, deposit DAI",
    }
   ]
}

Your response should include the valid JSON block and nothing else.
</output>`;

export const suggestStrategyAmountPrompt = (ctx: {
  decision: object;
  conversation: string;
  portfolio: string;
  availableTokens: string;
  strategies: string;
}) => `<task>
Generate suggestions for amount selection, given user's portfolio and available tokens
</task>
<decision>
${JSON.stringify(ctx.decision)}
</decision>
<conversation>
${ctx.conversation}
</conversation>
<strategies>
Strategies by risk profile:
${ctx.strategies}
</strategies>
<portfolio>
User has following tokens available in portfolio:
${ctx.portfolio}
</portfolio>
<availableTokens>
Tokens known to agent:
${ctx.availableTokens}
</availableTokens>
<instructions>
Look at user's portfolio for selected token balance and remember it as MAX amount.
Consider MAX as 0 if token is not in portfolio.
If MAX amount is 0: 
- Suggest other tokens instead, up to 4 suggestions.
- Example for "pool" strategy: { label: "Deposit USDT(486.36 available)", text: "I want to deposit USDT" }
- Example for "vault" strategy: { label: "Swap ETH(0.32 available) -> USDC", text: "I want to Swap ETH to USDC" }
If MAX amount above 0:
- If token is native decrease MAX amount by 5%
- Display 4 suggestions, start with MAX amount and decrease each consecutively by 30%, like [MAX, MAX * 0.7, MAX * 0.4, MAX * 0.1]
ONLY in case of "pool" strategy: add 2 additional suggestions to either decrease or increase leverage in range of 1-20x
IMPORTANT ORDERING RULES:
- First display tokens with higher balance in portfolio
- Additional suggestions(if any) should be added after main suggestions
</instructions>
<keys>
- "suggestions" should be an array of objects with the following keys:
  - "label"
  - "text"
</keys>
<output>
Respond using JSON format like in example:
{
  "suggestions": [
    {
      "label": "104.55 USDT",
      "text": "I want to deposit 104.55 USDT",
    },
    {
      "label": "70.92 USDT",
      "text": "I want to deposit 70.92 USDT",
    },
    {
      "label": "42.20 USDT",
      "text": "I want to deposit 42.20 USDT",
    },
    {
      "label": "29.54 USDT",
      "text": "I want to deposit 29.54 USDT",
    },
    {
      "label": "Increase leverage",
      "text": "I want to increase leverage to x10",
    },
    {
      "label": "Decrease leverage",
      "text": "I want to decrease leverage to x2",
    },
  ]
}

Your response should include the valid JSON block and nothing else.
</output>`;
