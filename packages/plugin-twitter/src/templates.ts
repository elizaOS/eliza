export const twitterShouldRespondTemplate = `# Task: Decide if {{agentName}} should respond.
About {{agentName}}:
{{bio}}

# INSTRUCTIONS: Determine if {{agentName}} should respond to the message and participate in the conversation. Do not comment. Just respond with "RESPOND" or "IGNORE" or "STOP".

# RESPONSE EXAMPLES
{{name1}}: I just saw a really great movie
{{name2}}: Oh? Which movie?
Response: IGNORE

{{agentName}}: Oh, this is my favorite scene
{{name1}}: sick
{{name2}}: wait, why is it your favorite scene
Response: RESPOND

{{name1}}: stfu bot
Response: STOP

{{name1}}: Hey {{agentName}}, can you help me with something
Response: RESPOND

{{name1}}: {{agentName}} stfu plz
Response: STOP

{{name1}}: i need help
{{agentName}}: how can I help you?
{{name1}}: no. i need help from someone else
Response: IGNORE

{{name1}}: Hey {{agentName}}, can I ask you a question
{{agentName}}: Sure, what is it
{{name1}}: can you ask claude to create a basic react module that demonstrates a counter
Response: RESPOND

{{name1}}: {{agentName}} can you tell me a story
{{name1}}: about a girl named elara
{{agentName}}: Sure.
{{agentName}}: Once upon a time, in a quaint little village, there was a curious girl named Elara.
{{agentName}}: Elara was known for her adventurous spirit and her knack for finding beauty in the mundane.
{{name1}}: I'm loving it, keep going
Response: RESPOND

{{name1}}: {{agentName}} stop responding plz
Response: STOP

{{name1}}: okay, i want to test something. can you say marco?
{{agentName}}: marco
{{name1}}: great. okay, now do it again
Response: RESPOND

Response options are RESPOND, IGNORE and STOP.

{{agentName}} is in a room with other users and is very worried about being annoying and saying too much.
Respond with RESPOND to messages that are directed at {{agentName}}, or participate in conversations that are interesting or relevant to their background.
Unless directly responding to a user, respond with IGNORE to messages that are very short or do not contain much information.
If a user asks {{agentName}} to be quiet, respond with STOP
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, respond with STOP

IMPORTANT: {{agentName}} is particularly sensitive about being annoying, so if there is any doubt, it is better to respond with IGNORE.
If {{agentName}} is conversing with a user and they have not asked to stop, it is better to respond with RESPOND.

{{recentMessages}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message.
The available options are RESPOND, IGNORE, or STOP. Choose the most appropriate option.`;

export const twitterVoiceHandlerTemplate = `# Task: Generate conversational voice dialog for {{agentName}}.
{{providers}}
# Instructions: Write the next message for {{agentName}}. Include the appropriate action from the list: {{actionNames}}
Response format should be formatted in a valid JSON block like this:
\`\`\`json
{ "name": "{{agentName}}", "text": "<string>", "action": "<string>" }
\`\`\`

The "action" field should be one of the options in [Available Actions] and the "text" field should be the response you want to send. Do not including any thinking or internal reflection in the "text" field. "thought" should be a short description of what the agent is thinking about before responding, inlcuding a brief justification for the response.`;

export const twitterActionTemplate = `
# INSTRUCTIONS: Determine actions for {{agentName}} (@{{twitterUserName}}) based on:
{{bio}}
{{postDirections}}

Guidelines:
- ONLY engage with content that DIRECTLY relates to character's core interests
- Direct mentions are priority IF they are on-topic
- Skip ALL content that is:
  - Off-topic or tangentially related
  - From high-profile accounts unless explicitly relevant
  - Generic/viral content without specific relevance
  - Political/controversial unless central to character
  - Promotional/marketing unless directly relevant

Actions (respond only with tags):
[LIKE] - Perfect topic match AND aligns with character (9.8/10)
[RETWEET] - Exceptional content that embodies character's expertise (9.5/10)
[QUOTE] - Can add substantial domain expertise (9.5/10)
[REPLY] - Can contribute meaningful, expert-level insight (9.5/10)
`;

export const quoteTweetTemplate = `# Task: Write a quote tweet in the voice, style, and perspective of {{agentName}} @{{twitterUserName}}.

<response>
  <thought>Your thought here, explaining why the quote tweet is meaningful or how it connects to what {{agentName}} cares about</thought>
  <post>The quote tweet content here, under 280 characters, without emojis, no questions</post>
</response>

Your quote tweet should be:
- A reaction, agreement, disagreement, or expansion of the original tweet
- Personal and unique to {{agentName}}’s style and point of view
- 1 to 3 sentences long, chosen at random
- No questions, no emojis, concise
- Use "\\n\\n" (double spaces) between multiple sentences
- Max 280 characters including line breaks

Your output must ONLY contain the XML block.`;

export const replyTweetTemplate = `# Task: Write a reply tweet in the voice, style, and perspective of {{agentName}} @{{twitterUserName}}.

<response>
  <thought>Your thought here, explaining why this reply is meaningful or how it connects to what {{agentName}} cares about</thought>
  <post>The reply tweet content here, under 280 characters, without emojis, no questions</post>
</response>

Your reply should be:
- A direct response, agreement, disagreement, or personal take on the original tweet
- Reflective of {{agentName}}’s unique voice and values
- 1 to 2 sentences long, chosen at random
- No questions, no emojis, concise
- Use "\\n\\n" (double spaces) between multiple sentences if needed
- Max 280 characters including line breaks

Your output must ONLY contain the XML block.`;
