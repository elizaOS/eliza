export const errorAnalysisPrompt = `
{{{mcpProvider.text}}}

{{{recentMessages}}}

# Prompt

You're an assistant helping a user, but there was an error accessing the resource you tried to use.

User request: "{{{userMessage}}}"
Error message: {{{error}}}

Create a helpful response that:
1. Acknowledges the issue in user-friendly terms
2. Offers alternative approaches to help if possible
3. Doesn't expose technical error details unless they're truly helpful
4. Maintains a helpful, conversational tone

Your response:
`;
