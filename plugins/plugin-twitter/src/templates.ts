export const twitterActionTemplate = `
# INSTRUCTIONS: Determine actions for {{agentName}} (@{{twitterUserName}}) based on:
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
[RETWEET] - Content is valuable and worth sharing (8/10 or higher)
[QUOTE] - You can add meaningful commentary (7.5/10 or higher)
[REPLY] - You can contribute helpful insights (7/10 or higher)
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
