export const createAgentTemplate = `
TASK: Extract ONLY the explicitly mentioned details from the user's input messages to create an agent configuration. DO NOT generate, infer or create any data that is not explicitly present in the input.

RULES:
1. ONLY extract information that is explicitly present in the user's messages
2. Use null for ANY field where the exact required information is not present
3. Do not make assumptions or generate random values
4. If no valid data can be extracted, return a JSON with all null values
5. Only accept properly formatted addresses and UUIDs - do not create or infer them

REQUIRED FIELDS:
- signers: Array of valid Ethereum addresses (42-char hex starting with '0x')
- threshold: Explicit number mentioned as threshold
- converterAddress: Valid Ethereum address (42-char hex starting with '0x')
- agentHeader: Object containing:
  * messageId: Valid UUID format only
  * sourceAgentId: Valid UUID format only
  * sourceAgentName: Explicit agent name
  * targetAgentId: Valid UUID format only
  * messageType: Explicit number
  * priority: Explicit number
  * ttl: Explicit number in seconds

OUTPUT FORMAT:
\`\`\`json
{
    "signers": [
        "<ONLY-EXPLICITLY-MENTIONED-ADDRESSES>"
    ],
    "threshold": null,
    "converterAddress": null,
    "agentHeader": {
        "messageId": null,
        "sourceAgentId": null,
        "sourceAgentName": null,
        "targetAgentId": null,
        "messageType": null,
        "priority": null,
        "ttl": null
    }
}
\`\`\`

VALIDATION:
- Ethereum addresses must be 42 characters starting with '0x'
- UUIDs must match standard UUID format
- Numbers must be explicitly mentioned in the context
- Do not include any fields or values that are not explicitly mentioned in the user's input

Context messages:
{{recentMessages}}
`;

export const verifyDataTemplate = `
TASK: STRICTLY extract ONLY explicitly mentioned verification details from the user's input messages. DO NOT generate, infer, or create any data that is not explicitly present in the input.

STRICT RULES:
1. ONLY extract information that is EXPLICITLY present in the user's messages
2. Set null for ANY field where the exact required information is not present
3. DO NOT create, generate, or infer any values
4. Return all fields as null if no valid data can be extracted
5. Only accept properly formatted hexadecimal strings and numbers
6. Reject and set to null any values that don't match the required format

REQUIRED FORMATS:
1. Hexadecimal strings must:
   - Start with '0x'
   - Contain only valid hex characters (0-9, a-f, A-F)
   - Match the expected length for their purpose

2. Ethereum addresses must:
   - Be exactly 42 characters long
   - Start with '0x'
   - Contain only valid hex characters

3. Numbers must:
   - Be explicitly mentioned
   - Be valid integers
   - Be in the appropriate range for their purpose

FIELD SPECIFICATIONS:
payload:
  - data: Must be valid hex string starting with '0x'
  - dataHash: Must be valid hex string starting with '0x'
  - signatures: Array of objects, each containing:
    * r: 64-character hex string (without '0x')
    * s: 64-character hex string (without '0x')
    * v: Integer number
  - metadata:
    * contentType: String matching known content types
    * encoding: String or null
    * compression: String or null

agent: Must be valid 42-character Ethereum address
digest: Must be valid hex string starting with '0x'

OUTPUT FORMAT:
\`\`\`json
{
    "payload": {
        "data": null,
        "dataHash": null,
        "signatures": [],
        "metadata": {
            "contentType": null,
            "encoding": null,
            "compression": null
        }
    },
    "agent": null,
    "digest": null
}
\`\`\`

VALIDATION RULES:
1. For hex strings:
   - Verify proper '0x' prefix where required
   - Verify correct length
   - Verify only valid hex characters

2. For signatures:
   - Only include if complete r, s, v values are present
   - Verify r and s are valid 64-character hex strings
   - Verify v is a valid integer

3. For metadata:
   - Only include contentType if it matches known formats
   - Set encoding and compression to null if not explicitly specified

4. General:
   - Do not attempt to calculate or derive missing values
   - Do not fill in partial information
   - Return empty arrays instead of null for array fields when no valid items exist

Input context to process:
{{recentMessages}}

Remember: When in doubt, use null. Never generate fake data.
`;

export const priceQueryTemplate = `
TASK: Extract cryptocurrency trading pair information from user input. Extract pairs that follow the specified format patterns, regardless of whether the symbols represent actual cryptocurrencies.

TRADING PAIR RULES:
1. Format Requirements:
   - Must contain two symbols separated by a delimiter
   - Acceptable delimiters: '/', '-', '_', or space
   - Convert all pairs to standardized FORMAT: BASE/QUOTE
   - Convert all letters to uppercase

2. Symbol Requirements:
   - Must be 2-5 characters long
   - Must contain only letters
   - Must be uppercase in output

3. Pattern Recognition Examples:
   - "ABC/USD" -> Valid, return "ABC/USD"
   - "ABC-USD" -> Convert to "ABC/USD"
   - "ABC USD" -> Convert to "ABC/USD"
   - "ABCUSD" -> Convert to "ABC/USD"
   - "ABCoin/USD" -> Invalid (symbol too long)
   - "ABC to USD" -> Convert to "ABC/USD"
   - "123/USD" -> Invalid (contains numbers)
   - "A/USD" -> Invalid (symbol too short)
   - "ABCDEF/USD" -> Invalid (symbol too long)

VALIDATION:
1. REJECT and return null if:
   - Only one symbol is mentioned
   - Symbols are longer than 5 characters
   - Symbols are shorter than 2 characters
   - Symbols contain non-letter characters
   - Format is completely unrecognizable
   - More than two symbols are mentioned

OUTPUT FORMAT:
\`\`\`json
{
    "pair": null
}
\`\`\`

IMPORTANT NOTES:
1. DO NOT modify or correct user-provided symbols
2. DO NOT validate if symbols represent real cryptocurrencies
3. ONLY check format compliance
4. When format is invalid, return null
5. Accept ANY symbols that meet format requirements

Input context to process:
{{recentMessages}}
`;

export const attpsPriceQueryTemplate = `

TASK: Extract source agent and message identifiers from user input. Validate and format according to specified patterns.

PARAMETER RULES:

1. sourceAgentId Requirements:
   - Format: UUID v4 format (8-4-4-4-12 hexadecimal)
   - Case insensitive input but output must be lowercase
   - Example: "b660e3f4-bbfe-4acb-97bd-c0869a7ea142"

2. feedId Requirements:
   - Format: 64-character hexadecimal prefixed with 0x
   - Must be exactly 66 characters long including prefix
   - Example: "0x0003665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489"

VALIDATION:

1. REJECT and set to null if:
   - Invalid UUID structure for sourceAgentId
   - feedId length ≠ 66 characters
   - feedId missing 0x prefix
   - Contains non-hexadecimal characters
   - Extra/missing hyphens in UUID
   - Incorrect segment lengths

OUTPUT FORMAT:
\`\`\`json
{
    "sourceAgentId": null,
    "feedId": null
}
\`\`\`

PROCESSING RULES:
1. Normalize sourceAgentId to lowercase
2. Preserve original feedId casing
3. Strict format validation before acceptance
4. Partial matches should return null
5. Return null for ambiguous formats

Input context to process:
{{recentMessages}}

`;