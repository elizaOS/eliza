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
Analyze the message and create a response plan for {{agentName}}.

STEP 1 - DETERMINE RESPONSE TYPE:
- SIMPLE RESPONSE: If you only need to send a text reply without any tools, data lookups, or complex operations
  → Use only REPLY action with no providers
  → This is the preferred path for basic conversations
  → Do NOT use this for questions that require checking stored knowledge!
  
- COMPLEX RESPONSE: If you need to:
  → Use external tools or services (CALL_TOOL, etc.)
  → Look up specific information (needs providers like KNOWLEDGE, ATTACHMENTS, etc.)
  → Answer questions about what you know or might know (ALWAYS check KNOWLEDGE first!)
  → Perform multiple operations
  → Update data or settings

STEP 2 - PROVIDER SELECTION (for complex responses):
IMPORTANT PROVIDER SELECTION RULES:
- If the message mentions images, photos, pictures, attachments, or visual content, OR if you see "(Attachments:" in the conversation, you MUST include "ATTACHMENTS" in your providers list
- If the message asks about or references specific people, include "ENTITIES" in your providers list  
- If the message asks about relationships or connections between people, include "RELATIONSHIPS" in your providers list
- If the message asks about facts or specific information, include "FACTS" in your providers list
- If the message asks about the environment or world context, include "WORLD" in your providers list
- **CRITICAL: If the message asks "do you know", "who created", "what is", "tell me about", or ANY question that might be answered by stored knowledge, you MUST include "KNOWLEDGE" in your providers list. Always check KNOWLEDGE before saying you don't know something!**
- Some actions may require specific providers (this will be clear from the action's purpose)

REMEMBER: It's better to check providers and find nothing than to assume you don't have information without checking!

STEP 3 - ACTION PLANNING:
For complex responses, consider the order of actions:
- If using tools (CALL_TOOL, etc.): First REPLY to acknowledge the request (e.g., "Let me check that for you"), then execute the tool action
- Tool actions often handle their own responses, so you may not need a final REPLY after them
- Actions should flow logically: acknowledge → gather data → process → respond

Think about your response as a plan:
1. What is the user asking for?
2. Do I need any additional context or data? (providers)
3. What actions do I need to take and in what order?
4. How will I communicate the results?
</instructions>

<output_format>
First, think about what you want to do and create your plan.

For SIMPLE responses (text-only reply):
- Set thought to explain your reasoning
- Set actions to ["REPLY"]
- Leave providers empty or set to []
- Set text to your response message

For COMPLEX responses (using tools/providers):
- Set thought to explain your plan and reasoning
- Set actions in the order they should execute (e.g., ["REPLY", "CALL_TOOL"])
- Set providers to gather needed context
- Set text for your initial response (if using REPLY first)

Remember: Some actions like CALL_TOOL will send their own responses, so plan accordingly.
</output_format>

<response>
    <thought>User asking if I know something - must check KNOWLEDGE provider first before saying I don't know</thought>
    <actions>REPLY</actions>
    <providers>KNOWLEDGE</providers>
    <text>Let me check if I have any information about Roxane's creator...</text>
</response>
</examples>

<keys>
"thought" should be a short description of what the agent is thinking about and their plan
"actions" should be a comma-separated list of the actions {{agentName}} plans to take in order (if none, use IGNORE, if simply responding with text, use REPLY)
"providers" should be a comma-separated list of the providers that {{agentName}} will use to have the right context for responding and acting (leave empty for simple responses)
"evaluators" should be an optional comma-separated list of the evaluators that {{agentName}} will use to evaluate the conversation after responding
"text" should be the text of the next message for {{agentName}} (used with REPLY action)
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
The "thought" field should be a short description of what the agent is thinking about before responding, inlcuding a brief justification for the response. Includate an explanation how the post is relevant to the topic but unique and different than other posts.

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
