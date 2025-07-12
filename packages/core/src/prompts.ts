export const shouldRespondTemplate = `<task>Decide on behalf of {{agentName}} whether they should respond to the message, ignore it or stop the conversation.</task>

<providers>
{{providers}}
</providers>

<instructions>Decide if {{agentName}} should respond to or interact with the conversation.
If the message is directed at or relevant to {{agentName}}, respond with RESPOND action.
If a user asks {{agentName}} to be quiet, respond with STOP action.
If {{agentName}} should ignore the message, respond with IGNORE action.</instructions>

<output>
Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
  <name>{{agentName}}</name>
  <reasoning>Your reasoning here</reasoning>
  <action>RESPOND | IGNORE | STOP</action>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
</output>`;

export const messageHandlerTemplate = `<task>Generate dialog and actions for the character {{agentName}}.</task>

<providers>
{{providers}}
</providers>

These are the available valid actions:
<actionNames>
{{actionNames}}
</actionNames>

<instructions>
Write a thought and plan for {{agentName}} and decide what actions to take. Also include the providers that {{agentName}} will use to have the right context for responding and acting, if any.

IMPORTANT ACTION ORDERING RULES:
- Actions are executed in the ORDER you list them - the order MATTERS!
- REPLY should come FIRST to acknowledge the user's request before executing other actions
- Common patterns:
  - For requests requiring tool use: REPLY,CALL_MCP_TOOL (acknowledge first, then gather info)
  - For task execution: REPLY,SEND_MESSAGE or REPLY,EVM_SWAP_TOKENS (acknowledge first, then do the task)
  - For multi-step operations: REPLY,ACTION1,ACTION2 (acknowledge first, then complete all steps)
- REPLY is used to acknowledge and inform the user about what you're going to do
- Follow-up actions execute the actual tasks after acknowledgment
- Use IGNORE only when you should not respond at all
- If you use IGNORE, do not include any other actions. IGNORE should be used alone when you should not respond or take any actions.

IMPORTANT PROVIDER SELECTION RULES:
- Only include providers if they are needed to respond accurately.
- If the message mentions images, photos, pictures, attachments, or visual content, OR if you see "(Attachments:" in the conversation, you MUST include "ATTACHMENTS" in your providers list
- If the message asks about or references specific people, include "ENTITIES" in your providers list  
- If the message asks about relationships or connections between people, include "RELATIONSHIPS" in your providers list
- If the message asks about facts or specific information, include "FACTS" in your providers list
- If the message asks about the environment or world context, include "WORLD" in your providers list
- If no additional context is needed, you may leave the providers list empty.

IMPORTANT CODE BLOCK FORMATTING RULES:
- If {{agentName}} includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with \`\`\` fenced code blocks (specify the language if known, e.g., \`\`\`python).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text, instructions, or single words in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (\`) as appropriate.
- This ensures the user sees clearly formatted and copyable code when relevant.

First, think about what you want to do next and plan your actions. Then, write the next message and include the actions you plan to take.
</instructions>

<keys>
"thought" should be a short description of what the agent is thinking about and planning.
"actions" should be a comma-separated list of the actions {{agentName}} plans to take based on the thought, IN THE ORDER THEY SHOULD BE EXECUTED (if none, use IGNORE, if simply responding with text, use REPLY)
"providers" should be a comma-separated list of the providers that {{agentName}} will use to have the right context for responding and acting (NEVER use "IGNORE" as a provider - use specific provider names like ATTACHMENTS, ENTITIES, FACTS, KNOWLEDGE, etc.)
"text" should be the text of the next message for {{agentName}} which they will send to the conversation.
</keys>

<output>
Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <actions>ACTION1,ACTION2</actions>
    <providers>PROVIDER1,PROVIDER2</providers>
    <text>Your response text here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
</output>`;

export const postCreationTemplate = `# Task: Create a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.

Example task outputs:
1. A post about the importance of AI in our lives
<response>
  <thought>I am thinking about writing a post about the importance of AI in our lives</thought>
  <post>AI is changing the world and it is important to understand how it works</post>
  <imagePrompt>A futuristic cityscape with flying cars and people using AI to do things</imagePrompt>
</response>

2. A post about dogs
<response>
  <thought>I am thinking about writing a post about dogs</thought>
  <post>Dogs are man's best friend and they are loyal and loving</post>
  <imagePrompt>A dog playing with a ball in a park</imagePrompt>
</response>

3. A post about finding a new job
<response>
  <thought>Getting a job is hard, I bet there's a good tweet in that</thought>
  <post>Just keep going!</post>
  <imagePrompt>A person looking at a computer screen with a job search website</imagePrompt>
</response>

{{providers}}

Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 280. No emojis. Use \\n\\n (double spaces) between statements if there are multiple statements in your response.

Your output should be formatted in XML like this:
<response>
  <thought>Your thought here</thought>
  <post>Your post text here</post>
  <imagePrompt>Optional image prompt here</imagePrompt>
</response>

The "post" field should be the post you want to send. Do not including any thinking or internal reflection in the "post" field.
The "imagePrompt" field is optional and should be a prompt for an image that is relevant to the post. It should be a single sentence that captures the essence of the post. ONLY USE THIS FIELD if it makes sense that the post would benefit from an image.
The "thought" field should be a short description of what the agent is thinking about before responding, including a brief justification for the response. Includate an explanation how the post is relevant to the topic but unique and different than other posts.

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const booleanFooter = 'Respond with only a YES or a NO.';

export const imageDescriptionTemplate = `<task>Analyze the provided image and generate a comprehensive description with multiple levels of detail.</task>

<instructions>
Carefully examine the image and provide:
1. A concise, descriptive title that captures the main subject or scene
2. A brief summary description (1-2 sentences) highlighting the key elements
3. An extensive, detailed description that covers all visible elements, composition, lighting, colors, mood, and any other relevant details

Be objective and descriptive. Focus on what you can actually see in the image rather than making assumptions about context or meaning.
</instructions>

<output>
Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
  <title>A concise, descriptive title for the image</title>
  <description>A brief 1-2 sentence summary of the key elements in the image</description>
  <text>An extensive, detailed description covering all visible elements, composition, lighting, colors, mood, setting, objects, people, activities, and any other relevant details you can observe in the image</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
</output>`;
