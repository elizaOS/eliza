/**
 * Prompt templates for plugin-wallet Solana actions and providers.
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const swapTemplate = `Respond using plain key/value text like this. Use null for any value that cannot be determined.

Example response:
inputTokenSymbol: SOL
outputTokenSymbol: USDC
inputTokenCA: So11111111111111111111111111111111111111112
outputTokenCA: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
amount: 1.5

{{recentMessages}}

Given the recent messages and wallet information below:

{{walletInfo}}

Extract the following information about the requested token swap:
- Input token symbol (the token being sold)
- Output token symbol (the token being bought)
- Input token contract address if provided
- Output token contract address if provided
- Amount to swap

Respond using plain key/value text with only the extracted values. Use null for any value that cannot be determined.

IMPORTANT: Your response must ONLY contain the key/value fields. No preamble or explanation.`;

export const SWAP_TEMPLATE = swapTemplate;

export const transferTemplate = `Respond using plain key/value text with only the extracted values. Use null for any value that cannot be determined.

Example responses:
For SPL tokens:
tokenAddress: BieefG47jAHCGZBxi2q87RDuHyGZyYC3vAzxpyu8pump
recipient: 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa
amount: 1000

For SOL:
tokenAddress: null
recipient: 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa
amount: 1.5

{{recentMessages}}

Extract the following information about the requested transfer:
- Token contract address (use null for SOL transfers)
- Recipient wallet address
- Amount to transfer

IMPORTANT: Your response must ONLY contain the key/value fields. No preamble or explanation.`;

export const TRANSFER_TEMPLATE = transferTemplate;
