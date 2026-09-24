/** Authored templates for basic capabilities behavior, preserving complete model context. */
import { registerResponsePolicy } from "../../prompts/response-policy.ts";

export const imageDescriptionTemplate = `Task: Analyze image and generate description with multiple detail levels.

Provide:
1. Concise descriptive title capturing main subject/scene
2. Brief summary (1-2 sentences) of key elements
3. Extensive description: visible elements, composition, lighting, colors, mood, etc.

Be objective. Describe what you see; don't assume context or meaning.

JSON:
title: A concise, descriptive title for the image
description: A brief 1-2 sentence summary of the key elements in the image
text: An extensive, detailed description covering all visible elements, composition, lighting, colors, mood, setting, objects, people, activities, and any other relevant details you can observe in the image

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const IMAGE_DESCRIPTION_TEMPLATE = imageDescriptionTemplate;

export const imageGenerationTemplate = `# Task: Generate image prompt for {{agentName}}.

{{providers}}

# Instructions:
Create a specific, descriptive image-generation prompt based on the conversation.

# Recent conversation:
{{recentMessages}}

JSON:
thought: Your reasoning for the image prompt
prompt: Detailed image generation prompt

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const IMAGE_GENERATION_TEMPLATE = imageGenerationTemplate;

export const postCreationTemplate = `# Task: Create a post in the voice/style/perspective of {{agentName}} @{{xUserName}}.

Example task outputs:
1. A post about the importance of AI in our lives
thought: I am thinking about writing a post about the importance of AI in our lives
post: AI is changing the world and it is important to understand how it works
imagePrompt: A futuristic cityscape with flying cars and people using AI to do things

2. A post about dogs
thought: I am thinking about writing a post about dogs
post: Dogs are man's best friend and they are loyal and loving
imagePrompt: A dog playing with a ball in a park

3. A post about finding a new job
thought: Getting a job is hard, I bet there's a good post in that
post: Just keep going!
imagePrompt: A person looking at a computer screen with a job search website

{{providers}}

Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from {{agentName}}'s perspective. No commentary, no acknowledgement, just the post.
1, 2, or 3 sentences (random length).
No questions. Brief, concise statements only. Total character count MUST be less than 280. No emojis. Use \\n\\n (double spaces) between statements.

Output JSON:
thought: Your thought here
post: Your post text here
imagePrompt: Optional image prompt here

"post": the post you want to send. No thinking or reflection.
"imagePrompt": optional, single sentence capturing the post's essence. Only use if the post benefits from an image.
"thought": short description of what the agent is thinking, with brief justification. Explain how the post is relevant but unique vs other posts.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const POST_CREATION_TEMPLATE = postCreationTemplate;

export const replyTemplate = `# Task: Generate dialog for character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.
"thought": short description of what the agent is thinking and planning.
"text": next message {{agentName}} will send.

Write text like natural conversation, not a database or debug log. Prefer concise everyday wording. Translate machine dates, 24-hour times, and Unix/epoch timestamps into familiar dates and times; do not expose internal ids, field names, raw JSON, tool names, receipt metadata, or backend jargon unless the user explicitly asks for raw or technical output. Preserve exact code and user-provided values when they are the subject of the request.

${registerResponsePolicy}

CODE BLOCK FORMATTING:
- For code examples, snippets, or multi-line code, ALWAYS wrap with \`\`\` fenced code blocks (specify language if known, e.g., \`\`\`python).
- ONLY use fenced blocks for actual code. Do NOT wrap non-code text in fences.
- For inline code (short single words or function names), use single backticks (\`).
- This ensures clean, copyable code formatting.

No <think> sections, no preamble.

JSON:
thought: Your thought here
text: Your message here

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const REPLY_TEMPLATE = replyTemplate;
