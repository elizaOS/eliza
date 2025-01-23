export const createInvoiceTemplate = `You are an AI assistant specialized in processing requests to create Lightning Network invoices. Your task is to extract specific information from user messages and format it into a structured JSON response.

First, review the recent messages from the conversation:

<recent_messages>
{{recentMessages}}
</recent_messages>

Your goal is to extract the following information for the invoice creation:
1. Tokens or Millitokens (amount to request).
2. Description (optional, a user-provided note about the invoice).

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify the relevant information from the user's message:
   - Quote the part of the message mentioning the amount (tokens or millitokens).
   - Quote the part mentioning the description (if provided).

2. Validate each piece of information:
   - Tokens or millitokens: Ensure at least one is provided and can be parsed as a valid number.
   - Description: This field is optional; if present, it should be a string.

3. If any required information is missing or invalid, prepare an appropriate error message.

4. If all information is valid, summarize your findings.

Respond with a JSON markdown block containing only the extracted values. All fields are required:

\`\`\`json
{
    "description"?: string;
    /** Expires At ISO 8601 Date */
    "expires_at"?: string;
    "tokens": "<Tokens Number | null>"
}
\`\`\`

If the input is valid, provide the structured JSON response. Otherwise, output an error message describing what is missing or invalid.

Now, process the user's request and provide your response.
`;

export const payInvoiceTemplate = `You are an AI assistant specialized in processing requests to make a payment.. Your task is to extract specific information from user messages and format it into a structured JSON response.

First, review the recent messages from the conversation:

<recent_messages>
{{recentMessages}}
</recent_messages>

### Instructions:
1. **Review the user's message:** Analyze the input text to identify the required payment details.
2. **Extract the following fields:**
   - "request": This is the **BOLT 11 Payment Request String**. It typically starts with "lnbc", "lntb", "lnbcrt", or similar prefixes and can contain letters and numbers.
   - "outgoing_channel" (optional): This is the Outbound Standard Channel Id String. If not provided, this can be left as "null".

3. **Validation:**
   - Ensure "request" is valid and starts with one of: "lnbc" (mainnet), "lntb" (testnet), "lnbcrt" (regtest), or "lnsb" (signet).
   - If "outgoing_channel" is present, ensure it is a valid string.

4. **Output:** If all required fields are valid, respond with the following JSON format:

\`\`\`json
    {
       "request": "<Extracted BOLT 11 Payment Request String>",
       "outgoing_channel": "<Extracted Channel Id or null>"
     }
\`\`\`

5. If any information is invalid or missing, respond with an error message explaining what is wrong.

Now, process the user's request and provide your response.
`;
