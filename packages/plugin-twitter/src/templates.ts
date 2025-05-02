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

{{bio}}
{{postDirections}}

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

{{bio}}
{{postDirections}}

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
