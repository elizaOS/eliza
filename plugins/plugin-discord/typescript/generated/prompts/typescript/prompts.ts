/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../../prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const attachmentIdsTemplate = `# Messages we are summarizing
{{recentMessages}}

# Instructions: {{senderName}} is requesting a summary of specific attachments. Your goal is to determine their objective, along with the list of attachment IDs to summarize.
The "objective" is a detailed description of what the user wants to summarize based on the conversation.
The "attachmentIds" is an array of attachment IDs that the user wants to summarize. If not specified, default to including all attachments from the conversation.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "objective": "<What the user wants to summarize>",
  "attachmentIds": ["<Attachment ID 1>", "<Attachment ID 2>", ...]
}
\`\`\``;

export const ATTACHMENT_IDS_TEMPLATE = attachmentIdsTemplate;

export const attachmentSummarizationTemplate = `# Summarized so far (we are adding to this)
{{currentSummary}}

# Current attachments we are summarizing
{{attachmentsWithText}}

Summarization objective: {{objective}}

# Instructions: Summarize the attachments. Return the summary. Do not acknowledge this request, just summarize and continue the existing summary if there is one. Capture any important details based on the objective. Only respond with the new summary text.`;

export const ATTACHMENT_SUMMARIZATION_TEMPLATE = attachmentSummarizationTemplate;

export const channelInfoTemplate = `# Messages we are searching for channel information
{{recentMessages}}

# Instructions: {{senderName}} is requesting to read messages from a specific Discord channel. Your goal is to determine:
1. The channel they want to read from (could be the current channel or a mentioned channel)
2. How many messages they want to read (default to 10 if not specified)
3. Whether they want a summary or just the messages
4. If they're looking for messages from a specific person

If they say "this channel" or "here", use the current channel.
If they mention a specific channel name or ID, extract that.
If they ask to "summarize" or mention what someone is "talking about", set summarize to true.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "channelIdentifier": "<current|channel-name|channel-id>",
  "messageCount": <number between 1 and 50>,
  "summarize": true/false,
  "focusUser": "<username or null>"
}
\`\`\``;

export const CHANNEL_INFO_TEMPLATE = channelInfoTemplate;

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

export const joinChannelTemplate = `# Messages we are searching for channel join information
{{recentMessages}}

# Instructions: {{senderName}} is requesting the bot to join a specific Discord channel (text or voice). Your goal is to determine which channel they want to join.

Extract the channel identifier from their request:
- If they mention a channel like #general or <#channelid>, extract that
- If they provide a channel name, extract that
- If they provide a channel ID (long number), extract that
- If they mention "voice", "vc", "voice channel", include that as a hint

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "channelIdentifier": "<channel-name|channel-id|#mention>",
  "isVoiceChannel": true/false
}
\`\`\``;

export const JOIN_CHANNEL_TEMPLATE = joinChannelTemplate;

export const leaveChannelTemplate = `# Messages we are searching for channel leave information
{{recentMessages}}

# Instructions: {{senderName}} is requesting the bot to leave a specific Discord channel (text or voice). Your goal is to determine which channel they want to leave.

Extract the channel identifier from their request:
- If they mention a channel like #general or <#channelid>, extract that
- If they provide a channel name (like "dev-voice" or "general"), extract just the name
- If they provide a channel ID (long number), extract that
- If they say "this channel" or "here", use "current"
- If they don't specify a channel but mention "voice", "vc", use "current" and mark as voice

Examples:
- "leave the dev-voice channel" -> channelIdentifier: "dev-voice", isVoiceChannel: true
- "leave #general" -> channelIdentifier: "general", isVoiceChannel: false
- "leave voice" -> channelIdentifier: "current", isVoiceChannel: true
- "stop listening to this channel" -> channelIdentifier: "current", isVoiceChannel: false

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "channelIdentifier": "<actual-channel-name-or-id-or-current>",
  "isVoiceChannel": true/false
}
\`\`\``;

export const LEAVE_CHANNEL_TEMPLATE = leaveChannelTemplate;

export const mediaAttachmentIdTemplate = `# Messages we are transcribing
{{recentMessages}}

# Instructions: {{senderName}} is requesting a transcription of a specific media file (audio or video). Your goal is to determine the ID of the attachment they want transcribed.
The "attachmentId" is the ID of the media file attachment that the user wants transcribed. If not specified, return null.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "attachmentId": "<Attachment ID>"
}
\`\`\``;

export const MEDIA_ATTACHMENT_ID_TEMPLATE = mediaAttachmentIdTemplate;

export const mediaUrlTemplate = `# Messages we are searching for a media URL
{{recentMessages}}

# Instructions: {{senderName}} is requesting to download a specific media file (video or audio). Your goal is to determine the URL of the media they want to download.
The "mediaUrl" is the URL of the media file that the user wants downloaded. If not specified, return null.

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "mediaUrl": "<Media URL>"
}
\`\`\``;

export const MEDIA_URL_TEMPLATE = mediaUrlTemplate;

export const pinMessageTemplate = `# Pinning a Discord message
{{recentMessages}}

# Instructions: {{senderName}} wants to pin a message. Extract which message they want to pin.

Examples:
- "pin that message" -> messageRef: "last"
- "pin the last message" -> messageRef: "last"
- "pin john's message about the meeting" -> messageRef: "john meeting"
- "pin message 123456789" -> messageRef: "123456789"

Your response must be formatted as a JSON block:
\`\`\`json
{
  "messageRef": "<last|previous|message-id|search-text>"
}
\`\`\``;

export const PIN_MESSAGE_TEMPLATE = pinMessageTemplate;

export const reactToMessageTemplate = `# Adding reactions to Discord messages
{{recentMessages}}

# Instructions: {{senderName}} wants to add a reaction to a message. Extract:
1. Which message to react to (last, specific message reference, or by content)
2. What emoji/reaction to add

Examples:
- "react with 👍 to the last message" -> messageRef: "last", emoji: "👍"
- "add :fire: reaction" -> messageRef: "last", emoji: "🔥" or ":fire:"
- "react to that message with ❤️" -> messageRef: "previous", emoji: "❤️"
- "add a thumbs up to john's message about the meeting" -> messageRef: "john meeting", emoji: "👍"

Your response must be formatted as a JSON block:
\`\`\`json
{
  "messageRef": "<last|previous|message-id|search-text>",
  "emoji": "<emoji-character|:emoji-name:>"
}
\`\`\``;

export const REACT_TO_MESSAGE_TEMPLATE = reactToMessageTemplate;

export const searchMessagesTemplate = `# Searching for Discord messages
{{recentMessages}}

# Instructions: {{senderName}} is requesting to search for messages in Discord. Extract:
1. The search query/keywords
2. The channel to search in (current if not specified)
3. Optional filters like author, time range, or message count

Examples:
- "search for messages containing 'meeting'" -> query: "meeting", channelIdentifier: "current", NO author field
- "find messages from @user about bugs" -> query: "bugs", channelIdentifier: "current", author: "user"
- "search #general for links from last week" -> query: "links", channelIdentifier: "general", timeRange: "week"
- "search for messages about 'spartan' in this channel" -> query: "spartan", channelIdentifier: "current"

Your response must be formatted as a JSON block:
\`\`\`json
{
  "query": "<search keywords>",
  "channelIdentifier": "<channel-name|channel-id|current>",
  "author": "<username>",
  "timeRange": "<hour|day|week|month>",
  "limit": <number between 1-100, default 20>
}
\`\`\``;

export const SEARCH_MESSAGES_TEMPLATE = searchMessagesTemplate;

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

export const transcriptionTemplate = `# Transcription of media file
{{mediaTranscript}}

# Instructions: Return only the full transcript of the media file without any additional prompt or commentary.`;

export const TRANSCRIPTION_TEMPLATE = transcriptionTemplate;

export const unpinMessageTemplate = `# Unpinning a Discord message
{{recentMessages}}

# Instructions: {{senderName}} wants to unpin a message. Extract which message they want to unpin.

Examples:
- "unpin that message" -> messageRef: "last_pinned"
- "unpin the last pinned message" -> messageRef: "last_pinned"
- "unpin john's message" -> messageRef: "john"
- "unpin message about the meeting" -> messageRef: "meeting"

Your response must be formatted as a JSON block:
\`\`\`json
{
  "messageRef": "<last_pinned|message-id|search-text>"
}
\`\`\``;

export const UNPIN_MESSAGE_TEMPLATE = unpinMessageTemplate;

