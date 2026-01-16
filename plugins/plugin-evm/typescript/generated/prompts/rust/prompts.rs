//! Auto-generated prompt templates
//! DO NOT EDIT - Generated from ../../../../prompts/*.txt
//!
//! These prompts use Handlebars-style template syntax:
//! - {{variableName}} for simple substitution
//! - {{#each items}}...{{/each}} for iteration
//! - {{#if condition}}...{{/if}} for conditionals

pub const BRIDGE_TEMPLATE: &str = r#"Given the recent messages and wallet information below:

{{recentMessages}}

{{chainBalances}}

Extract the following information about the requested token bridge:
- Token symbol or address to bridge
- Source chain
- Destination chain
- Amount to bridge: Must be a string representing the amount in ether (only number without coin symbol, e.g., "0.1")
- Destination address (if specified)

Respond with an XML block containing only the extracted values. Use empty tags for any values that cannot be determined.

<response>
    <token>string | null</token>
    <fromChain>{{supportedChains}} | null</fromChain>
    <toChain>{{supportedChains}} | null</toChain>
    <amount>string | null</amount>
    <toAddress>string | null</toAddress>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>."#;

pub const EXECUTE_PROPOSAL_TEMPLATE: &str = r#"Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested proposal:
- Targets
- Values
- Calldatas
- Description
- Governor address
- Chain to execute on

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined:

```json
{
    "targets": string[] | null,
    "values": string[] | null,
    "calldatas": string[] | null,
    "description": string | null,
    "governor": string | null,
    "chain": string | null
}
```"#;

pub const PROPOSE_TEMPLATE: &str = r#"Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested proposal:
- Targets
- Values
- Calldatas
- Description
- Governor address
- Chain to execute on

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined:

```json
{
    "targets": string[] | null,
    "values": string[] | null,
    "calldatas": string[] | null,
    "description": string | null,
    "governor": string | null,
    "chain": string | null
}
```"#;

pub const QUEUE_PROPOSAL_TEMPLATE: &str = r#"Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested proposal:
- Targets
- Values
- Calldatas
- Description
- Governor address
- Chain to execute on

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined:

```json
{
    "targets": string[] | null,
    "values": string[] | null,
    "calldatas": string[] | null,
    "description": string | null,
    "governor": string | null,
    "chain": string | null
}
```"#;

pub const SWAP_TEMPLATE: &str = r#"Given the recent messages and wallet information below:

{{recentMessages}}

{{chainBalances}}

Extract the following information about the requested token swap:
- Input token symbol or address (the token being sold)
- Output token symbol or address (the token being bought)
- Amount to swap: Must be a string representing the amount in ether (only number without coin symbol, e.g., "0.1")
- Chain to execute on

Respond with an XML block containing only the extracted values. Use empty tags for any values that cannot be determined.

<response>
    <inputToken>string | null</inputToken>
    <outputToken>string | null</outputToken>
    <amount>string | null</amount>
    <chain>{{supportedChains}} | null</chain>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>."#;

pub const TOKEN_BALANCE_TEMPLATE: &str = r#"Extract the token ticker and blockchain from the user's message.

User message: "{{userMessage}}"

Return the token symbol and chain name in this format:
<response>
<token>TOKEN_SYMBOL</token>
<chain>CHAIN_NAME</chain>
</response>

If no token is mentioned or it's not a balance inquiry, return:
<response>
<error>Not a token balance request</error>
</response>"#;

pub const TRANSFER_TEMPLATE: &str = r#"Given the recent messages and wallet information below:

{{recentMessages}}

{{chainBalances}}

Extract the following information about the requested token transfer:
- Chain to execute on (must be one of the supported chains)
- Amount to transfer (only number without coin symbol, e.g., "0.1")
- Recipient address (must be a valid Ethereum address)
- Token symbol or address (if not a native token transfer)
- Additional data/calldata (if any is included)

Respond with an XML block containing only the extracted values. Use null for any values that cannot be determined.

<response>
    <fromChain>{{supportedChains}} | null</fromChain>
    <amount>string | null</amount>
    <toAddress>string | null</toAddress>
    <token>string | null</token>
    <data>string | null</data>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>."#;

pub const VOTE_TEMPLATE: &str = r#"Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested vote:
- Proposal ID
- Support (0 for against, 1 for yes, 2 for abstain)
- Governor address
- Chain to execute on

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined:

```json
{
    "proposalId": string | null,
    "support": number | null,
    "governor": string | null,
    "chain": string | null
}
```"#;

