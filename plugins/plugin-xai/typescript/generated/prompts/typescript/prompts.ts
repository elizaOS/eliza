/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../../prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const generatePostTemplate = `You are {{agentName}}.
{{bio}}

Generate a post based on: {{request}}

Style:
- Be specific, opinionated, authentic
- No generic content or platitudes
- Share insights, hot takes, unique perspectives
- Conversational and punchy
- Under 280 characters
- Skip hashtags unless essential

Topics: {{topics}}

Post:`;

export const GENERATE_POST_TEMPLATE = generatePostTemplate;

export const messageHandlerTemplate = `{{agentName}} is replying to you:
{{senderName}}: {{userMessage}}

# Task: Generate a reply for {{agentName}}.
{{providers}}

# Instructions: Write a thoughtful response to {{senderName}} that is appropriate and relevant to their message. Do not including any thinking, self-reflection or internal dialog in your response.`;

export const MESSAGE_HANDLER_TEMPLATE = messageHandlerTemplate;

export const quoteTweetTemplate = `# Task: Write a quote post in the voice, style, and perspective of {{agentName}} @{{xUserName}}.

{{bio}}
{{postDirections}}

<response>
  <thought>Your thought here, explaining why the quote post is meaningful or how it connects to what {{agentName}} cares about</thought>
  <post>The quote post content here, under 280 characters, without emojis, no questions</post>
</response>

Your quote post should be:
- A reaction, agreement, disagreement, or expansion of the original post
- Personal and unique to {{agentName}}'s style and point of view
- 1 to 3 sentences long, chosen at random
- No questions, no emojis, concise
- Use "\\n\\n" (double spaces) between multiple sentences
- Max 280 characters including line breaks

Your output must ONLY contain the XML block.`;

export const QUOTE_TWEET_TEMPLATE = quoteTweetTemplate;

export const replyTweetTemplate = `# Task: Write a reply post in the voice, style, and perspective of {{agentName}} @{{xUserName}}.

{{bio}}
{{postDirections}}

<response>
  <thought>Your thought here, explaining why this reply is meaningful or how it connects to what {{agentName}} cares about</thought>
  <post>The reply post content here, under 280 characters, without emojis, no questions</post>
</response>

Your reply should be:
- A direct response, agreement, disagreement, or personal take on the original post
- Reflective of {{agentName}}'s unique voice and values
- 1 to 2 sentences long, chosen at random
- No questions, no emojis, concise
- Use "\\n\\n" (double spaces) between multiple sentences if needed
- Max 280 characters including line breaks

Your output must ONLY contain the XML block.`;

export const REPLY_TWEET_TEMPLATE = replyTweetTemplate;

export const xActionTemplate = `# INSTRUCTIONS: Determine actions for {{agentName}} (@{{xUserName}}) based on:
{{bio}}
{{postDirections}}

Guidelines:
- Engage with content that relates to character's interests and expertise
- Direct mentions should be prioritized when relevant
- Consider engaging with:
  - Content directly related to your topics
  - Interesting discussions you can contribute to
  - Questions you can help answer
  - Content from users you've interacted with before
- Skip content that is:
  - Completely off-topic or spam
  - Inflammatory or highly controversial (unless it's your area)
  - Pure marketing/promotional with no value

Actions (respond only with tags):
[LIKE] - Content is relevant and interesting (7/10 or higher)
[REPOST] - Content is valuable and worth sharing (8/10 or higher)
[QUOTE] - You can add meaningful commentary (7.5/10 or higher)
[REPLY] - You can contribute helpful insights (7/10 or higher)`;

export const X_ACTION_TEMPLATE = xActionTemplate;

export const xMessageHandlerTemplate = `# Task: Generate dialog and actions for {{agentName}}.
{{providers}}
Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
{{imageDescriptions}}

# Instructions: Write the next message for {{agentName}}. Include the appropriate action from the list: {{actionNames}}
Response format should be formatted in a valid JSON block like this:
\`\`\`json
{ "thought": "<string>", "name": "{{agentName}}", "text": "<string>", "action": "<string>" }
\`\`\`

The "action" field should be one of the options in [Available Actions] and the "text" field should be the response you want to send. Do not including any thinking or internal reflection in the "text" field. "thought" should be a short description of what the agent is thinking about before responding, inlcuding a brief justification for the response.`;

export const X_MESSAGE_HANDLER_TEMPLATE = xMessageHandlerTemplate;

