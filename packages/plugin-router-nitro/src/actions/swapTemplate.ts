export const swapTemplate = `Using the provided context and wallet information:

{{recentMessages}}

Extract the following details for the cross-chain swap request:
- **From Token**: The symbol of the token to swap from.
- **To Token**: The symbol of the token to swap into (default: same as "From Token").
- **Source Chain**: The chain to swap from.
- **Destination Chain**: The chain to swap into (default: same as "Source Chain").
- **Amount**: The amount to swap, in the "From Token."
- **Destination Address**: The address to send the swapped token to (if specified ).
If the destination address is not specified, the ROUTER NITRO EVM address of the runtime should be used.

If a value is not explicitly provided, use the default specified above.

Respond with a JSON object containing only the extracted information:

\\\`json
{
    "fromToken": string | null,
    "toToken": string | null,
    "fromChain": string | null,
    "toChain": string | null,
    "amount": string | null,
    "toAddress": string | null
}
\\\`
`;
