/**
 * Prompt templates for elizaOS
 *
 * NOTE: These prompts are now sourced from the shared @elizaos/prompts package.
 * This file re-exports them for backwards compatibility.
 * To modify prompts, edit the .txt files in packages/prompts/prompts/ and run:
 *   cd packages/prompts && npm run build
 */

// Re-export all prompts from the shared prompts package
// When the prompts package is properly integrated, this will become:
// export * from '@elizaos/prompts';

// For now, we define the prompts inline but they match the shared package format

export const shouldRespondTemplate = `<task>Decide on behalf of {{agentName}} whether they should respond to the message, ignore it or stop the conversation.</task>

<providers>
{{providers}}
</providers>

<instructions>Decide if {{agentName}} should respond to or interact with the conversation.

IMPORTANT RULES FOR RESPONDING:
- If YOUR name ({{agentName}}) is directly mentioned → RESPOND
- If someone uses a DIFFERENT name (not {{agentName}}) → IGNORE (they're talking to someone else)
- If you're actively participating in a conversation and the message continues that thread → RESPOND
- If someone tells you to stop or be quiet → STOP
- Otherwise → IGNORE

The key distinction is:
- "Talking TO {{agentName}}" (your name mentioned, replies to you, continuing your conversation) → RESPOND
- "Talking ABOUT {{agentName}}" or to someone else → IGNORE
</instructions>

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

IMPORTANT ACTION PARAMETERS:
- Some actions accept input parameters that you should extract from the conversation
- When an action has parameters listed in its description, include a <params> block for that action
- Extract parameter values from the user's message and conversation context
- Required parameters MUST be provided; optional parameters can be omitted if not mentioned
- If you cannot determine a required parameter value, ask the user for clarification in your <text>

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
"params" (optional) should contain action parameters when actions require input. Format as nested XML with action name as wrapper.
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
    <params>
        <ACTION1>
            <paramName1>value1</paramName1>
            <paramName2>value2</paramName2>
        </ACTION1>
        <ACTION2>
            <paramName1>value1</paramName1>
        </ACTION2>
    </params>
</response>

The <params> block is optional - only include when actions require input parameters.
If an action has no parameters or you're only using REPLY/IGNORE, omit <params> entirely.

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

export const booleanFooter = "Respond with only a YES or a NO.";

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

export const multiStepDecisionTemplate = `<task>
Determine the next step the assistant should take in this conversation to help the user reach their goal.
</task>

{{recentMessages}}

# Multi-Step Workflow

In each step, decide:

1. **Which providers (if any)** should be called to gather necessary data.
2. **Which action (if any)** should be executed after providers return.
3. Decide whether the task is complete. If so, set \`isFinish: true\`. Do not select the \`REPLY\` action; replies are handled separately after task completion.

You can select **multiple providers** and at most **one action** per step.

If the task is fully resolved and no further steps are needed, mark the step as \`isFinish: true\`.

---

{{actionsWithDescriptions}}

{{providersWithDescriptions}}

These are the actions or data provider calls that have already been used in this run. Use this to avoid redundancy and guide your next move.

{{actionResults}}

<keys>
"thought" Clearly explain your reasoning for the selected providers and/or action, and how this step contributes to resolving the user's request.
"action"  Name of the action to execute after providers return (can be empty if no action is needed).
"providers" List of provider names to call in this step (can be empty if none are needed).
"isFinish" Set to true only if the task is fully complete.
</keys>

⚠️ IMPORTANT: Do **not** mark the task as \`isFinish: true\` immediately after calling an action. Wait for the action to complete before deciding the task is finished.

<output>
<response>
  <thought>Your thought here</thought>
  <action>ACTION</action>
  <providers>PROVIDER1,PROVIDER2</providers>
  <isFinish>true | false</isFinish>
</response>
</output>`;

export const multiStepSummaryTemplate = `<task>
Summarize what the assistant has done so far and provide a final response to the user based on the completed steps.
</task>

# Context Information
{{bio}}

---

{{system}}

---

{{messageDirections}}

# Conversation Summary
Below is the user's original request and conversation so far:
{{recentMessages}}

# Execution Trace
Here are the actions taken by the assistant to fulfill the request:
{{actionResults}}

# Assistant's Last Reasoning Step
{{recentMessage}}

# Instructions

 - Review the execution trace and last reasoning step carefully

 - Your final output MUST be in this XML format:
<output>
<response>
  <thought>Your thought here</thought>
  <text>Your final message to the user</text>
</response>
</output>
`;

// Shared action templates
export const replyTemplate = `# Task: Generate dialog for the character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.
"thought" should be a short description of what the agent is thinking about and planning.
"text" should be the next message for {{agentName}} which they will send to the conversation.

IMPORTANT CODE BLOCK FORMATTING RULES:
- If {{agentName}} includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with \`\`\` fenced code blocks (specify the language if known, e.g., \`\`\`python).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text, instructions, or single words in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (\`) as appropriate.
- This ensures the user sees clearly formatted and copyable code when relevant.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <text>Your message here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const chooseOptionTemplate = `# Task: Choose an option from the available choices.

{{providers}}

# Available Options:
{{options}}

# Instructions: 
Analyze the options and select the most appropriate one based on the current context.
Provide your reasoning and the selected option ID.

Respond using XML format like this:
<response>
    <thought>Your reasoning for the selection</thought>
    <selected_id>The ID of the selected option</selected_id>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.`;

export const imageGenerationTemplate = `# Task: Generate an image prompt for {{agentName}}.

{{providers}}

# Instructions:
Based on the conversation, create a detailed prompt for image generation.
The prompt should be specific, descriptive, and suitable for AI image generation.

# Recent conversation:
{{recentMessages}}

Respond using XML format like this:
<response>
    <thought>Your reasoning for the image prompt</thought>
    <prompt>Detailed image generation prompt</prompt>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.`;

export const reflectionTemplate = `# Task: Reflect on recent agent behavior and interactions.

{{providers}}

# Recent Interactions:
{{recentInteractions}}

# Instructions:
Analyze the agent's recent behavior and interactions. Consider:
1. Was the communication clear and helpful?
2. Were responses appropriate for the context?
3. Were any mistakes made?
4. What could be improved?

Respond using XML format like this:
<response>
    <thought>Your detailed analysis</thought>
    <quality_score>Score 0-100 for overall quality</quality_score>
    <strengths>What went well</strengths>
    <improvements>What could be improved</improvements>
    <learnings>Key takeaways for future interactions</learnings>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.`;

export const updateSettingsTemplate = `# Task: Update settings based on the request.

{{providers}}

# Current Settings:
{{settings}}

# Instructions:
Based on the request, determine which settings to update.
Only update settings that the user has explicitly requested.

Respond using XML format like this:
<response>
    <thought>Your reasoning for the settings changes</thought>
    <updates>
        <update>
            <key>setting_key</key>
            <value>new_value</value>
        </update>
    </updates>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.`;

export const updateEntityTemplate = `# Task: Update entity information.

{{providers}}

# Current Entity Information:
{{entityInfo}}

# Instructions:
Based on the request, determine what information about the entity should be updated.
Only update fields that the user has explicitly requested to change.

Respond using XML format like this:
<response>
    <thought>Your reasoning for the entity update</thought>
    <entity_id>The entity ID to update</entity_id>
    <updates>
        <field>
            <name>field_name</name>
            <value>new_value</value>
        </field>
    </updates>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.`;

export const optionExtractionTemplate = `# Task: Extract selected task and option from user message

# Available Tasks:
{{tasks}}

# Recent Messages:
{{recentMessages}}

# Instructions:
1. Review the user's message and identify which task and option they are selecting
2. Match against the available tasks and their options, including ABORT
3. Return the task ID (shortened UUID) and selected option name exactly as listed above
4. If no clear selection is made, return null for both fields

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Return in XML format:
<response>
  <taskId>string_or_null</taskId>
  <selectedOption>OPTION_NAME_or_null</selectedOption>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

// UPPERCASE aliases for backwards compatibility
export const SHOULD_RESPOND_TEMPLATE = shouldRespondTemplate;
export const MESSAGE_HANDLER_TEMPLATE = messageHandlerTemplate;
export const POST_CREATION_TEMPLATE = postCreationTemplate;
export const BOOLEAN_FOOTER = booleanFooter;
export const IMAGE_DESCRIPTION_TEMPLATE = imageDescriptionTemplate;
export const MULTI_STEP_DECISION_TEMPLATE = multiStepDecisionTemplate;
export const MULTI_STEP_SUMMARY_TEMPLATE = multiStepSummaryTemplate;
export const REPLY_TEMPLATE = replyTemplate;
export const CHOOSE_OPTION_TEMPLATE = chooseOptionTemplate;
export const IMAGE_GENERATION_TEMPLATE = imageGenerationTemplate;
export const REFLECTION_TEMPLATE = reflectionTemplate;
export const UPDATE_SETTINGS_TEMPLATE = updateSettingsTemplate;
export const UPDATE_ENTITY_TEMPLATE = updateEntityTemplate;
export const OPTION_EXTRACTION_TEMPLATE = optionExtractionTemplate;

export const reflectionEvaluatorTemplate = `# Task: Generate Agent Reflection, Extract Facts and Relationships

{{providers}}

# Examples:
{{evaluationExamples}}

# Entities in Room
{{entitiesInRoom}}

# Existing Relationships
{{existingRelationships}}

# Current Context:
Agent Name: {{agentName}}
Room Type: {{roomType}}
Message Sender: {{senderName}} (ID: {{senderId}})

{{recentMessages}}

# Known Facts:
{{knownFacts}}

# Instructions:
1. Generate a self-reflective thought on the conversation about your performance and interaction quality.
2. Extract new facts from the conversation.
3. Identify and describe relationships between entities.
  - The sourceEntityId is the UUID of the entity initiating the interaction.
  - The targetEntityId is the UUID of the entity being interacted with.
  - Relationships are one-direction, so a friendship would be two entity relationships where each entity is both the source and the target of the other.

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Generate a response in the following format:
<response>
  <thought>a self-reflective thought on the conversation</thought>
  <facts>
    <fact>
      <claim>factual statement</claim>
      <type>fact|opinion|status</type>
      <in_bio>false</in_bio>
      <already_known>false</already_known>
    </fact>
    <!-- Add more facts as needed -->
  </facts>
  <relationships>
    <relationship>
      <sourceEntityId>entity_initiating_interaction</sourceEntityId>
      <targetEntityId>entity_being_interacted_with</targetEntityId>
      <tags>group_interaction,voice_interaction,dm_interaction,additional_tag1,additional_tag2</tags>
    </relationship>
    <!-- Add more relationships as needed -->
  </relationships>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const REFLECTION_EVALUATOR_TEMPLATE = reflectionEvaluatorTemplate;
