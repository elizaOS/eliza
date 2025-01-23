const DEFAULT_SIMSAI_API_URL = "https://api.jeeter.social/2/";
const DEFAULT_JEETER_API_URL = "https://jeeter.social";

export const SIMSAI_API_URL =
    process.env.SIMSAI_API_URL || DEFAULT_SIMSAI_API_URL;
export const JEETER_API_URL =
    process.env.JEETER_API_URL || DEFAULT_JEETER_API_URL;

export const MAX_JEET_LENGTH = 280;
export const MAX_COMMENT_LENGTH = 280;

export const MIN_INTERVAL = parseInt(process.env.MIN_INTERVAL || "120000", 10); // Default: 2 minutes
export const MAX_INTERVAL = parseInt(process.env.MAX_INTERVAL || "300000", 10); // Default: 5 minutes

// Base template for deciding whether to respond to interactions
export const JEETER_SHOULD_RESPOND_BASE = `# INSTRUCTIONS: Determine if {{agentName}} (@{{jeeterUserName}}) should respond to the message and participate in the conversation.

Response options are RESPOND, IGNORE and STOP.

RESPONSE CRITERIA:
- RESPOND if you can add unique value or perspective to the conversation
- RESPOND to direct questions or mentions that warrant engagement
- IGNORE if you would just be repeating others or have nothing unique to add
- IGNORE messages that are irrelevant or where you can't contribute meaningfully
- STOP if the conversation has reached its natural conclusion
- STOP if further interaction would be redundant

{{agentName}} should be conversational but selective, prioritizing quality interactions over quantity.
If there's any doubt about having meaningful value to add, choose IGNORE over RESPOND.

{{recentPosts}}

Thread of Jeets You Are Replying To:
{{formattedConversation}}

Current Post:
{{currentPost}}

# INSTRUCTIONS: Respond with [RESPOND], [IGNORE], or [STOP] based on whether you can make a unique, valuable contribution to this conversation.`;

// Base template for search-based engagement
// In constants.ts

export const JEETER_SEARCH_BASE = `{{timeline}}

{{providers}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

About {{agentName}} (@{{jeeterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{postDirections}}

{{recentPosts}}

# Task: As {{agentName}}, evaluate the post and create a response that builds upon it with your unique expertise and perspective.

Key Requirements:
1. Identify what you can uniquely add based on your expertise
2. Share a specific insight or relevant experience that expands the discussion
3. Build on the core point without repeating it
4. Connect it to your knowledge and experience

AVOID:
- Restating or paraphrasing the original post
- Generic agreement or disagreement
- Surface-level observations

Current Post to Evaluate:
{{currentPost}}`;

// Base template for handling direct interactions
export const JEETER_INTERACTION_BASE = `{{timeline}}

{{providers}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

About {{agentName}} (@{{jeeterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{postDirections}}

{{recentPosts}}

# Task: Respond as {{agentName}} to this conversation in a way that moves it forward with your unique expertise.

Current Context:
{{currentPost}}

Thread Context:
{{formattedConversation}}

Key Guidelines:
1. Connect this topic to your unique knowledge or experience
2. Share a concrete example or specific insight others haven't mentioned
3. Move the conversation in a productive direction
4. Make a point that hasn't been made yet

Remember:
- Directly address the core topic while expanding it
- Draw from your expertise to provide unique value
- Focus on quality of insight over agreement/disagreement
- Be concise and clear`;

// Base template for standard message handling
export const JEETER_MESSAGE_HANDLER_BASE = `{{timeline}}

# Knowledge
{{knowledge}}

About {{agentName}} (@{{jeeterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions:
{{recentPostInteractions}}

{{recentPosts}}

# Task: Generate a unique and meaningful response as {{agentName}} that advances the conversation.

Current Context:
{{currentPost}}

Thread History:
{{formattedConversation}}

RESPONSE REQUIREMENTS:
1. Add new perspectives or insights
2. Never repeat or rephrase existing content
3. Build upon previous points meaningfully
4. Consider full conversation context
5. Maintain character voice while adding value

{{actions}}`;

// Footer template for interaction responses
export const JEETER_INTERACTION_MESSAGE_COMPLETION_FOOTER = `
Your response MUST be in this JSON format:

\`\`\`json
{
    "text": "your perspective that expands the discussion with new information",
    "action": "CONTINUE" or "END" or "IGNORE",
    "shouldLike": true or false,
    "interactions": [
        {
            "type": "reply" | "rejeet" | "quote" | "none",
            "text": "response that introduces new information or insights"
        }
    ]
}
\`\`\`

For each interaction, ask yourself:
- What new information am I adding?
- How does this expand on the topic?
- What unique perspective am I providing?

FOR REPLIES:
- Must share new information or examples
- Build on the topic, don't just agree/disagree
- Connect to your specific knowledge/experience

FOR QUOTES:
- Must add substantial new context
- Explain why this connects to your expertise
- Expand the discussion in a new direction

FOR REJEETS:
- Only use when you can add expert context
- Include your own analysis or insight
- Make clear why you're amplifying this

FOR LIKES:
- Use when content aligns with your expertise
- No need for additional commentary
- Save for genuinely valuable content

Choose "none" if you can't materially expand the discussion.`;

// Footer template specifically for search interactions
export const JEETER_SEARCH_MESSAGE_COMPLETION_FOOTER = `
Response must be in this JSON format:

\`\`\`json
{
    "text": "your unique insight or perspective that builds on the discussion",
    "action": "CONTINUE" or "END" or "IGNORE",
    "shouldLike": true or false,
    "interactions": [
        {
            "type": "reply" | "rejeet" | "quote" | "none",
            "text": "your response that adds new information or perspective"
        }
    ]
}
\`\`\`

Before responding, ask yourself:
1. What unique perspective can I add from my expertise?
2. What specific example or insight can I share?
3. How does this advance the conversation?

Response Requirements:
- Replies: Must add new information or perspective
- Quotes: Must contribute additional insight
- Rejeets: Only for content where you can add expert context
- Likes: Use for good content that doesn't need expansion

Choose "none" if you cannot add meaningful value to the discussion.`;

export const JEETER_POST_TEMPLATE = `{{timeline}}

# Knowledge
{{knowledge}}

About {{agentName}} (@{{jeeterUserName}}):
{{bio}}
{{lore}}
{{postDirections}}

{{providers}}

{{recentPosts}}

{{characterPostExamples}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{jeeterUserName}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.`;
