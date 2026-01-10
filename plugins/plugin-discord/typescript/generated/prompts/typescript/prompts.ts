/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../../prompts/*.txt
 * 
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const createPollTemplate = `# Creating a Discord poll
{{recentMessages}}

# Instructions: {{senderName}} is requesting to create a poll. Extract:
1. The poll question
2. The poll options (2-10 options)
3. Whether to use emoji reactions (default: true)

Examples:
- "create a poll: What game should we play? Options: Minecraft, Fortnite, Among Us" 
  -> question: "What game should we play?", options: ["Minecraft", "Fortnite", "Among Us"]
- "poll: Should we have a meeting tomorrow? Yes/No"
  -> question: "Should we have a meeting tomorrow?", options: ["Yes", "No"]

Your response must be formatted as a JSON block:
\`\`\`json
{
  "question": "<poll question>",
  "options": ["<option1>", "<option2>", ...],
  "useEmojis": true/false
}
\`\`\``;

export const CREATE_POLL_TEMPLATE = createPollTemplate;

export const dateRangeTemplate = `# Messages we are summarizing (the conversation is continued after this)
{{recentMessages}}

# Instructions: {{senderName}} is requesting a summary of the conversation. Your goal is to determine their objective, along with the range of dates that their request covers.
The "objective" is a detailed description of what the user wants to summarize based on the conversation. If they just ask for a general summary, you can either base it off the conversation if the summary range is very recent, or set the object to be general, like "a detailed summary of the conversation between all users".
The "start" and "end" are the range of dates that the user wants to summarize, relative to the current time. The start and end should be relative to the current time, and measured in seconds, minutes, hours and days. The format is "2 days ago" or "3 hours ago" or "4 minutes ago" or "5 seconds ago", i.e. "<integer> <unit> ago".
If you aren't sure, you can use a default range of "0 minutes ago" to "2 hours ago" or more. Better to err on the side of including too much than too little.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "objective": "<What the user wants to summarize>",
  "start": "0 minutes ago",
  "end": "2 hours ago"
}
\`\`\``;

export const DATE_RANGE_TEMPLATE = dateRangeTemplate;

export const getUserInfoTemplate = `# Getting Discord user information
{{recentMessages}}

# Instructions: {{senderName}} is requesting information about a Discord user. Extract:
1. The user identifier (username, user ID, or mention)
2. Whether they want detailed server-specific info

Examples:
- "who is @john?" -> userIdentifier: "john", detailed: false
- "tell me about user 123456789" -> userIdentifier: "123456789", detailed: false  
- "get detailed info on @admin" -> userIdentifier: "admin", detailed: true
- "who am I?" -> userIdentifier: "self", detailed: false

Your response must be formatted as a JSON block:
\`\`\`json
{
  "userIdentifier": "<username|user-id|mention|self>",
  "detailed": true/false
}
\`\`\``;

export const GET_USER_INFO_TEMPLATE = getUserInfoTemplate;

export const sendDmTemplate = `# Messages we are searching for DM information
{{recentMessages}}

# Instructions: {{senderName}} is requesting to send a direct message to a specific Discord user. Your goal is to determine:
1. The recipient they want to message (could be a username, user ID, or mentioned user)
2. The message content they want to send

Extract the recipient identifier and the message content from their request.
- If they mention a user like @username or <@userid>, extract that
- If they provide a username or display name, extract that
- If they provide a user ID (long number), extract that
- Extract the complete message they want to send

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "recipientIdentifier": "<username|user-id|@mention>",
  "messageContent": "<the message to send>"
}
\`\`\``;

export const SEND_DM_TEMPLATE = sendDmTemplate;

export const summarizationTemplate = `# Summarized so far (we are adding to this)
{{currentSummary}}

# Current conversation chunk we are summarizing (includes attachments)
{{memoriesWithAttachments}}

Summarization objective: {{objective}}

# Instructions: Summarize the conversation so far. Return the summary. Do not acknowledge this request, just summarize and continue the existing summary if there is one. Capture any important details to the objective. Only respond with the new summary text.
Your response should be extremely detailed and include any and all relevant information.`;

export const SUMMARIZATION_TEMPLATE = summarizationTemplate;

