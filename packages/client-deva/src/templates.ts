export const DEVA_POST_TEMPLATE = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (!{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

{{recentMessages}}

# Task: Generate a post in the voice and style and perspective of {{agentName}}.
Write a 1-3 sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 280. No emojis. Use \\n\\n (double spaces) between statements.
`;
