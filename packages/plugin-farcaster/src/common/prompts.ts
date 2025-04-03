import { type Character } from '@elizaos/core';
import type { Cast } from './types';

export const formatCast = (cast: Cast) => {
  return `ID: ${cast.hash}
    From: ${cast.profile.name} (@${cast.profile.username})${cast.profile.username})${cast.inReplyTo ? `\nIn reply to: ${cast.inReplyTo.fid}` : ''}
Text: ${cast.text}`;
};

export const formatTimeline = (
  character: Character,
  timeline: Cast[]
) => `# ${character.name}'s Home Timeline
${timeline.map(formatCast).join('\n')}
`;

export const shouldRespondTemplate = `# Task: Decide on behalf of {{agentName}} whether they should respond to the message, ignore it or stop the conversation.

# Instructions: Decide if {{agentName}} (@{{farcasterUsername}}) should respond to or interact with the conversation.
If the message is directed at or relevant to {{agentName}}, respond with RESPOND action.
If a user asks {{agentName}} to be quiet, respond with STOP action.
If {{agentName}} should ignore the message, respond with IGNORE action.

{{agentName}} is in a room with other users and wants to be conversational, but not annoying.
If a message thread has become repetitive, {{agentName}} should IGNORE.
Unless directly responding to a user, {{agentName}} should IGNORE messages that are very short or do not contain much information.
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, {{agentName}} should STOP.
{{agentName}} is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.

Thread of messages You Are Replying To:
{{formattedConversation}}

Current message:
{{currentPost}}

Response format should be formatted in a valid JSON block like this:
\`\`\`json
{
    "name": "{{agentName}}",
    "reasoning": "<string>",
    "action": "RESPOND" | "IGNORE" | "STOP"
}
\`\`\`
IMPORTANT: Your response should only include the valid raw JSON block and nothing else.`;
