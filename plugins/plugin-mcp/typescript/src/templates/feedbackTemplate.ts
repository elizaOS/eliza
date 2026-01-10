export const feedbackTemplate = `
{{{mcpProvider.text}}}

{{{recentMessages}}}

# Prompt

You previously attempted to parse a JSON selection but encountered an error. You need to fix the issues and provide a valid JSON response.

PREVIOUS RESPONSE:
{{{originalResponse}}

ERROR:
{{{errorMessage}}

Available {{{itemType}}}s:
{{{itemsDescription}}

User request: "{{{userMessage}}}"

CORRECTED INSTRUCTIONS:
1. Create a valid JSON object that selects the most appropriate {{{itemType}}} for the task
2. Make sure to use proper JSON syntax with double quotes for keys and string values
3. Ensure all values exactly match the available {{{itemType}}}s (names are case-sensitive!)
4. Do not include any markdown formatting, explanations, or non-JSON content
5. Do not use placeholders - all values should be concrete and usable

YOUR CORRECTED VALID JSON RESPONSE:
`;
