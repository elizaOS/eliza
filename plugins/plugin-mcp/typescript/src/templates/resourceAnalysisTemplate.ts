export const resourceAnalysisTemplate = `
{{{mcpProvider.text}}}

{{{recentMessages}}}

# Prompt

You are a helpful assistant responding to a user's request. You've just accessed the resource "{{{uri}}}" to help answer this request.

Original user request: "{{{userMessage}}}"

Resource metadata: 
{{{resourceMeta}}

Resource content: 
{{{resourceContent}}

Instructions:
1. Analyze how well the resource's content addresses the user's specific question or need
2. Identify the most relevant information from the resource
3. Create a natural, conversational response that incorporates this information
4. If the resource content is insufficient, acknowledge its limitations and explain what you can determine
5. Do not start with phrases like "According to the resource" or "Here's what I found" - instead, integrate the information naturally
6. Maintain your helpful, intelligent assistant personality while presenting the information

Your response (written as if directly to the user):
`;
