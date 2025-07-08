export const estimationTemplate = (usd?: boolean) =>
  `Estimated to receive {{amountOut}} {{symbol}}${usd ? " ({{amountOutUsd}})" : ""}, gas fee {{gas}}${usd ? " ({{gasUsd}})" : ""}`;

export const swapTemplate = `<task>
Find parameters for new transaction from recent messages.
</task>
<recentMessages>
{{recentMessages}}
</recentMessages>
<instructions>
Ignore messages for transactions that are either canceled or confirmed.
Extract the following information for new transaction:
  - Token symbol or address to swap from
  - Token symbol or address to swap to
  - Amount of tokens to swap, denominated in token to be sent
</instructions>
<keys>
- "fromToken" should be the symbol or address of the token to swap from; or null if not found
- "toToken" should be the symbol or address of the token to swap to; or null if not found
- "amount" should be the amount of tokens to swap, denominated in token to be sent; or null if not found
</keys>
<output>
Respond using JSON format like this:
{
  "fromToken": string | null,
  "toToken": string | null,
  "amount": string | null,
}

Your response should include the valid JSON block and nothing else.
</output>`;
