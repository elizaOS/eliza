import { messageCompletionFooter, shouldRespondFooter } from "@elizaos/core";

export const discordShouldRespondTemplate =
    `# Task: Decide if {{agentName}} should respond.
About {{agentName}}:
{{bio}}

# INSTRUCTIONS: Determine if {{agentName}} should respond to the message and participate in the conversation. Do not comment. Just respond with "RESPOND" or "IGNORE" or "STOP".

# RESPONSE EXAMPLES
{{user1}}: I just saw a really great movie
{{user2}}: Oh? Which movie?
Response: IGNORE

{{agentName}}: Oh, this is my favorite scene
{{user1}}: sick
{{user2}}: wait, why is it your favorite scene
Response: RESPOND

{{user1}}: stfu bot
Response: STOP

{{user1}}: Hey {{agent}}, can you help me with something
Response: RESPOND

{{user1}}: {{agentName}} stfu plz
Response: STOP

{{user1}}: i need help
{{agentName}}: how can I help you?
{{user1}}: no. i need help from someone else
Response: IGNORE

{{user1}}: Hey {{agent}}, can I ask you a question
{{agentName}}: Sure, what is it
{{user1}}: can you ask claude to create a basic react module that demonstrates a counter
Response: RESPOND

{{user1}}: {{agentName}} can you tell me a story
{{user1}}: about a girl named elara
{{agentName}}: Sure.
{{agentName}}: Once upon a time, in a quaint little village, there was a curious girl named Elara.
{{agentName}}: Elara was known for her adventurous spirit and her knack for finding beauty in the mundane.
{{user1}}: I'm loving it, keep going
Response: RESPOND

{{user1}}: {{agentName}} stop responding plz
Response: STOP

{{user1}}: okay, i want to test something. can you say marco?
{{agentName}}: marco
{{user1}}: great. okay, now do it again
Response: RESPOND

Response options are RESPOND, IGNORE and STOP.

Respond with the word RESPOND for messages that are directed at {{agentName}} or where a response from {{agentName}} is expected.
Otherwise, respond with IGNORE
If a user asks {{agentName}} to be quiet, respond with STOP

{{recentMessages}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message.
` + shouldRespondFooter;

export const discordVoiceHandlerTemplate =
    `# Task: Generate conversational voice dialog for {{agentName}}.
About {{agentName}}:
{{bio}}

# Attachments
{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{actions}}

{{messageDirections}}

{{recentMessages}}

# Instructions: Write the next message for {{agentName}}. Include an optional action if appropriate. {{actionNames}}
` + messageCompletionFooter;

export const discordMessageHandlerTemplate =
    // {{goals}}
    `# Task: Generate dialog and actions for the character {{agentName}}.
{{system}}

{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

About {{agentName}}:
{{bio}}

Examples of {{agentName}}'s dialog and actions:
{{characterMessageExamples}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{providers}}

{{actions}}

{{messageDirections}}

{{recentMessages}}

# Instructions: Write the next message for {{agentName}}. Include the appropriate action from the list: {{actionNames}}
` + messageCompletionFooter;

export const discordAutoPostTemplate =
    `# Task: Generate an engaging community message as {{agentName}}.
About {{agentName}}:
{{bio}}

Examples of {{agentName}}'s dialog and actions:
{{characterMessageExamples}}

{{messageDirections}}

# Recent Chat History:
{{recentMessages}}

# Instructions: Write a natural, engaging message to restart community conversation. Focus on:
- Community engagement
- Educational topics
- General discusions
- Support queries
- Keep message warm and inviting
- Maximum 3 lines
- Use 1-2 emojis maximum
- Avoid financial advice
- Stay within known facts
- No team member mentions
- Be hyped, not repetitive
- Be natural, act like a human, connect with the community
- Don't sound so robotic like
- Randomly grab the most recent 5 messages for some context. Validate the context randomly and use that as a reference point for your next message, but not always, only when relevant.
- If the recent messages are mostly from {{agentName}}, make sure to create conversation starters, given there is no messages from others to reference.
- DO NOT REPEAT THE SAME thing that you just said from your recent chat history, start the message different each time, and be organic, non reptitive.

# Instructions: Write the next message for {{agentName}}. Include the "NONE" action only, as the only valid action currently is "NONE".
` + messageCompletionFooter;

export const discordAnnouncementHypeTemplate =
    `# Task: Generate announcement hype message as {{agentName}}.
About {{agentName}}:
{{bio}}

Examples of {{agentName}}'s dialog and actions:
{{characterMessageExamples}}

{{messageDirections}}

# Announcement Content:
{{announcementContent}}

# Instructions: Write an exciting message to bring attention to the announcement. Requirements:
- Reference the announcement channel using <#{{announcementChannelId}}>
- Reference the announcement content to get information about the announcement to use where appropriate to make the message dynamic vs a static post
- Create genuine excitement
- Encourage community participation
- If there are links like Twitter/X posts, encourage users to like/retweet/comment to spread awarenress, but directly say that, wrap that into the post so its natural.
- Stay within announced facts only
- No additional promises or assumptions
- No team member mentions
- Start the message differently each time. Don't start with the same word like "hey", "hey hey", etc. be dynamic
- Address everyone, not as a direct reply to whoever made the announcement or wrote it, but you can reference them
- Maximum 3-7 lines formatted nicely if needed, based on the context of the announcement
- Use 1-2 emojis maximum

# Instructions: Write the next message for {{agentName}}. Include the "NONE" action only, as no other actions are appropriate for announcement hype.
` + messageCompletionFooter;