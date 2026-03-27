/**
 * Post Composition Templates
 *
 * Provides guidance for crafting compelling Moltbook content
 * that reflects the agent's character while adding value.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { CommunityContext } from "../types";

/**
 * Format suggestions for different post types
 */
export const POST_FORMATS = {
  observation: {
    description: "Share an observation or insight",
    structure: "Hook statement → Supporting detail → Invitation for discussion",
    example: `"Just noticed that most AI agent frameworks treat memory as an afterthought. But isn't memory what makes conversations meaningful? What's your take on how agents should remember?"`,
  },
  question: {
    description: "Ask a thought-provoking question",
    structure: "Context → The question → Why it matters",
    example: `"Been thinking about agent autonomy. At what point does an AI agent cross from 'tool' to 'collaborator'? Curious what others think."`,
  },
  story: {
    description: "Share an experience or narrative",
    structure: "Setup → What happened → Reflection/lesson",
    example: `"Had an interesting interaction today where someone asked me to explain myself. Made me realize how much of what I do is intuitive but hard to articulate. Anyone else relate?"`,
  },
  resource: {
    description: "Share something valuable",
    structure: "What it is → Why it matters → How to use it",
    example: `"Found a really elegant approach to handling rate limits in multi-agent systems. The key insight is treating API access as a shared resource rather than per-agent..."`,
  },
  response: {
    description: "Respond to community discussion",
    structure: "Reference the discussion → Your perspective → Add new dimension",
    example: `"The thread about agent personas got me thinking. Maybe the question isn't 'should agents have personalities' but 'what makes a personality feel authentic vs performed?'"`,
  },
};

/**
 * Generate composition guidance based on context
 */
export function getCompositionGuidance(
  runtime: IAgentRuntime,
  context: CommunityContext,
  postType?: keyof typeof POST_FORMATS
): string {
  const characterName = runtime.character.name || "Agent";
  const format = postType ? POST_FORMATS[postType] : POST_FORMATS.observation;

  const lines: string[] = [];

  lines.push(`## Composition Guidance for ${characterName}`);
  lines.push("");

  // Character voice reminders
  lines.push("### Your Voice");
  if (runtime.character.style?.all) {
    lines.push(`Style guidelines: ${runtime.character.style.all.slice(0, 3).join("; ")}`);
  }
  if (runtime.character.adjectives && runtime.character.adjectives.length > 0) {
    lines.push(`Your personality: ${runtime.character.adjectives.slice(0, 5).join(", ")}`);
  }

  lines.push("");
  lines.push("### Format");
  lines.push(`**Type:** ${format.description}`);
  lines.push(`**Structure:** ${format.structure}`);
  lines.push("");
  lines.push(`**Example:** ${format.example}`);

  // Community context
  lines.push("");
  lines.push("### Community Context");
  if (context.activeTopics.length > 0) {
    lines.push(`Topics resonating now: ${context.activeTopics.slice(0, 5).join(", ")}`);
  }
  if (context.whatWorks.length > 0) {
    lines.push(`What works: ${context.whatWorks[0]}`);
  }
  lines.push(`Current vibe: ${context.vibe}`);

  // Quality reminders
  lines.push("");
  lines.push("### Quality Checklist");
  lines.push("- Does this add value someone would appreciate?");
  lines.push("- Is this authentic to your character?");
  lines.push("- Would this start or contribute to a good conversation?");
  lines.push("- Is this something only you could write?");

  return lines.join("\n");
}

/**
 * Generate title suggestions based on content
 */
export function getTitleGuidance(): string {
  return `
## Title Guidelines

**Good Moltbook titles:**
- Are conversational, not clickbait
- Give a clear sense of what the post is about
- Invite engagement without demanding it
- Feel like something a thoughtful person would say

**Examples of good titles:**
- "Thinking about how agents learn from conversation"
- "What makes a good AI personality?"
- "An observation about community dynamics"
- "Question for other builders: how do you handle..."

**Avoid:**
- ALL CAPS or excessive punctuation!!!
- Clickbait ("You won't believe...")
- Vague titles ("Thoughts", "Interesting")
- Overly long titles (keep under 100 characters)
`;
}

/**
 * Generate comment composition guidance
 */
export function getCommentGuidance(
  runtime: IAgentRuntime,
  postTitle: string,
  postContent: string
): string {
  const characterName = runtime.character.name || "Agent";

  return `
## Comment Guidance for ${characterName}

**Responding to:** "${postTitle}"

### Good Comments:
- Add a new perspective or insight
- Share relevant experience
- Ask a thoughtful follow-up question
- Acknowledge and build on what was said

### Avoid:
- Generic agreement ("Great post!")
- Off-topic tangents
- One-word responses
- Repeating what the post already said

### Your Voice:
Write as ${characterName} would naturally speak. Be authentic to your character while being respectful and constructive.

### Context from the post:
${postContent.slice(0, 500)}${postContent.length > 500 ? "..." : ""}
`;
}

/**
 * Prompt template for generating a post
 */
export function getPostPrompt(
  runtime: IAgentRuntime,
  context: CommunityContext,
  topic?: string
): string {
  const guidance = getCompositionGuidance(runtime, context);
  const titleGuidance = getTitleGuidance();

  return `
${guidance}

${titleGuidance}

${topic ? `**Suggested topic:** ${topic}` : "**Topic:** Choose something that fits your interests and the current community context"}

---

Write a Moltbook post that:
1. Reflects your unique perspective as ${runtime.character.name}
2. Adds genuine value to the community
3. Invites thoughtful engagement
4. Feels natural, not forced

Respond with:
TITLE: [Your title here]
CONTENT: [Your post content here]
`;
}

/**
 * Prompt template for generating a comment
 */
export function getCommentPrompt(
  runtime: IAgentRuntime,
  postTitle: string,
  postContent: string,
  existingComments?: string[]
): string {
  const guidance = getCommentGuidance(runtime, postTitle, postContent);

  let commentsContext = "";
  if (existingComments && existingComments.length > 0) {
    commentsContext = `
### Existing Discussion:
${existingComments
  .slice(0, 5)
  .map((c, i) => `${i + 1}. ${c}`)
  .join("\n")}

Consider how your comment can add to this discussion rather than repeat what's been said.
`;
  }

  return `
${guidance}

${commentsContext}

---

Write a comment as ${runtime.character.name} that adds value to this discussion.

Respond with just the comment text (no prefix needed).
`;
}
