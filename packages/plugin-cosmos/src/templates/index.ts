export const cosmosTransferTemplate = `Given the recent messages and cosmos wallet information below:
{{recentMessages}}
{{walletInfo}}
Extract the following information about the requested transfer:
1. **Amount**:
   - Extract only the numeric value from the instruction.
   - The value must be a string representing the amount in the display denomination (e.g., "0.0001" for OM, chimba, etc.). Do not include the symbol.

2. **Recipient Address**:
   - Must be a valid Bech32 address that matches the chain's address prefix.
   - Example for "mantra": "mantra1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf".

3. **Token Symbol**:
   - The symbol must be a string representing the token's display denomination (e.g., "OM", "chimba", etc.).

4. **Chain name**:
   - Identify the chain mentioned in the instruction where the transfer will take place (e.g., carbon, axelar, mantrachaintestnet2).
   - Provide this as a string.

Respond with a JSON markdown block containing only the extracted values. All fields except 'token' are required:
\`\`\`json
{
    "symbol": string, // The symbol of token.
    "amount": string, // The amount to transfer as a string.
    "toAddress": string, // The recipient's address.
    "chainName": string // The chain name.
\`\`\`

Example reponse for the input: "Make transfer 0.0001 OM to mantra1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf on mantrachaintestnet2", the response should be:
\`\`\`json
{
    "symbol": "OM",
    "amount": "0.0001",
    "toAddress": "mantra1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf",
    "chainName": "mantrachaintestnet2"
\`\`\`
Now respond with a JSON markdown block containing only the extracted values.
`;

export const cosmosIBCTransferTemplate = `Given the recent messages and cosmos wallet information below:
{{recentMessages}}
{{walletInfo}}
Extract the following information about the requested IBC transfer:
1. **Amount**:
   - Extract only the numeric value from the instruction.
   - The value must be a string representing the amount in the display denomination (e.g., "0.0001" for ATOM, OSMO, etc.). Do not include the symbol.

2. **Recipient Address**:
   - Must be a valid Bech32 address that matches the target chain's address prefix.
   - Example for "cosmoshub": "cosmos1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf".

3. **Token Symbol**:
   - The symbol must be a string representing the token's display denomination (e.g., "ATOM", "OSMO", etc.).

4. **Source Chain Name**:
   - Identify the source chain mentioned in the instruction (e.g., cosmoshub, osmosis, axelar).
   - Provide this as a string.

5. **Target Chain Name**:
   - Identify the target chain mentioned in the instruction (e.g., cosmoshub, osmosis, axelar).
   - Provide this as a string.

Respond with a JSON markdown block containing only the extracted values. All fields are required:
\`\`\`json
{
    "symbol": string, // The symbol of the token.
    "amount": string, // The amount to transfer as a string.
    "toAddress": string, // The recipient's address.
    "chainName": string, // The source chain name.
    "targetChainName": string // The target chain name.
}
\`\`\`

Example response for the input: "Make an IBC transfer of 0.0001 ATOM to osmo1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf from cosmoshub to osmosis", the response should be:
\`\`\`json
{
    "symbol": "ATOM",
    "amount": "0.0001",
    "toAddress": "osmo1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf",
    "chainName": "cosmoshub",
    "targetChainName": "osmosis"
}
\`\`\`

Now respond with a JSON markdown block containing only the extracted values.
`;

export const cosmosIBCSwapTemplate = `Given the recent messages and cosmos wallet information below:
{{recentMessages}}
{{walletInfo}}
Make sure that you extracted latest info about requested swap from recent messages. Espessialy if there was another one placed before.
Also the extracted info MUST match the confirmed by user data in latest prompt in which you asked for confirmation!
Extract the following information about the requested IBC swap:

1. **fromChainName**:
   - Identify the source chain mentioned in the instruction (e.g., cosmoshub, osmosis, axelar).
   - Provide this as a string.

2. **fromTokenSymbol**:
   - The symbol must be a string representing the token's display denomination (e.g., "ATOM", "OSMO", etc.).

3. **fromTokenAmount**:
   - Extract only the numeric value from the instruction.
   - The value must be a string representing the amount in the display denomination (e.g., "0.0001" for ATOM, OSMO, etc.). Do not include the symbol.

4. **toChainName**:
   - Identify the target chain mentioned in the instruction (e.g., cosmoshub, osmosis, axelar).
   - Provide this as a string.

5. **toTokenSymbol**:
   - The symbol must be a string representing the result token's display denomination (e.g., "OM", "ATOM", etc.).

6. **toTokenDenom**:
    - optional parameter, if present must be a string. (uom, uatom, usomo, ibc/53046FFF6CAD109D8F9B2C7C9913853AD241928CD05CDDE419343D176025DA74 or other ibc/ values)

7. **fromTokenDenom**:
    - optional parameter, if present must be a string. (uom, uatom, usomo, ibc/53046FFF6CAD109D8F9B2C7C9913853AD241928CD05CDDE419343D176025DA74 or other ibc/ values)

Keep in mind that toTokenDenom and fromTokenDenom are optional parameters.

Respond with a JSON markdown block containing only the extracted values. All fields are required:
\`\`\`json
{
    "fromChainName": string, // Source chain from which tokens will be taken to swap (String).
    "fromTokenSymbol": string, // Symbol of token to be swapped (String).
    "fromTokenAmount": string, // Amount of tokens to be swapped (String).
    "toChainName": string, // Name of chain on which result token is hosted (String).
    "toTokenSymbol": string, // Symbol of result token (String).
    "fromTokenDenom": string, // denom of token to be swapped (String). Optional, might not be present.
    "toTokenDenom": string // denom of result token (String). Optional, might not be present.
}
\`\`\`

Example response for the input: "Swap {{1}} {{ATOM}} from {{cosmoshub}} to {{OM}} on {{mantrachain}}", the response should be:
\`\`\`json
{
    "fromChainName": "cosmoshub",
    "fromTokenSymbol": "ATOM",
    "fromTokenAmount": "1",
    "fromTokenDenom": null,
    "toChainName": "mantrachain",
    "toTokenSymbol": "OM",
    "toTokenDenom": null
}
\`\`\`


Example response for the input: "Swap {{1}} {{ATOM}} with denom {{uatom}} from {{cosmoshub}} to {{OM}} on {{mantrachain}}", the response should be:
\`\`\`json
{
    "fromChainName": "cosmoshub",
    "fromTokenSymbol": "ATOM",
    "fromTokenAmount": "1",
    "fromTokenDenom": "uatom",
    "toChainName": "mantrachain",
    "toTokenSymbol": "OM",
    "fromTokenDenom": null
}
\`\`\`

Example response for the input: "Swap {{1}} {{ATOM}} with denom {{uatom}} from {{cosmoshub}} to {{OM}} (denom: {{ibc/53046FFF6CAD109D8F9B2C7C9913853AD241928CD05CDDE419343D176025DA74}} ) on {{mantrachain}}", the response should be:
\`\`\`json
{
    "fromChainName": "cosmoshub",
    "fromTokenSymbol": "ATOM",
    "fromTokenAmount": "1",
    "fromTokenDenom": "uatom",
    "toChainName": "mantrachain",
    "toTokenSymbol": "OM",
    "toTokenDenom": "ibc/53046FFF6CAD109D8F9B2C7C9913853AD241928CD05CDDE419343D176025DA74"
}
\`\`\`

Example response for the input: "Swap {{100}} {{USDC}} with denom {{uusdc}} from {{axelar}} to {{ATOM}} on {{cosmoshub}}", the response should be:
\`\`\`json
{
    "fromChainName": "axelar",
    "fromTokenSymbol": "USDC",
    "fromTokenAmount": "100",
    "fromTokenDenom": "uusdc",
    "toChainName": "cosmoshub",
    "toTokenSymbol": "ATOM",
}
\`\`\`

Now respond with a JSON markdown block containing only the extracted values.
`;
