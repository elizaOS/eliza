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

EXAMPLE (action parameters):
User message: "Send a message to @dev_guru on telegram saying Hello!"
Actions: REPLY,SEND_MESSAGE
Params:
<params>
    <SEND_MESSAGE>
        <targetType>user</targetType>
        <source>telegram</source>
        <target>dev_guru</target>
        <text>Hello!</text>
    </SEND_MESSAGE>
</params>

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

export const postCreationTemplate = `# Task: Create a post in the voice and style and perspective of {{agentName}} @{{xUserName}}.

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
  <thought>Getting a job is hard, I bet there's a good post in that</thought>
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

// Contact action templates
export const scheduleFollowUpTemplate = `# Schedule Follow-up

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the follow-up scheduling information from the message:
1. Who to follow up with (name or entity reference)
2. When to follow up (date/time or relative time like "tomorrow", "next week")
3. Reason for the follow-up
4. Priority (high, medium, low)
5. Any specific message or notes

## Current Date/Time
{{currentDateTime}}

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to follow up with</contactName>
<entityId>ID if known, otherwise leave empty</entityId>
<scheduledAt>ISO datetime for the follow-up</scheduledAt>
<reason>Reason for the follow-up</reason>
<priority>high, medium, or low</priority>
<message>Optional message or notes for the follow-up</message>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const addContactTemplate = `# Add Contact to Rolodex

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the contact information from the message and determine:
1. Who should be added as a contact (name or entity reference)
2. What category they belong to (friend, family, colleague, acquaintance, vip, business)
3. Any preferences or notes mentioned

Respond with the extracted information in XML format.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to add</contactName>
<entityId>ID if known, otherwise leave empty</entityId>
<categories>comma-separated categories</categories>
<notes>Any additional notes or preferences</notes>
<timezone>Timezone if mentioned</timezone>
<language>Language preference if mentioned</language>
<reason>Reason for adding this contact</reason>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const searchContactsTemplate = `# Search Contacts

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the search criteria from the message:
1. Categories to filter by (friend, family, colleague, acquaintance, vip, business)
2. Search terms (names or keywords)
3. Tags to filter by
4. Any other filters mentioned

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<categories>comma-separated list of categories to filter by</categories>
<searchTerm>search term for names</searchTerm>
<tags>comma-separated list of tags</tags>
<intent>list, search, or count</intent>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const removeContactTemplate = `# Remove Contact from Rolodex

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the contact removal information from the message:
1. Who to remove (name or entity reference)
2. Confirmation of the intent to remove

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to remove</contactName>
<confirmed>yes or no</confirmed>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const updateContactTemplate = `# Update Contact Information

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the contact update information from the message:
1. Who to update (name or entity reference)
2. What fields to update (categories, tags, preferences, notes, custom fields)
3. Whether to add to or replace existing values

## Current Date/Time
{{currentDateTime}}

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to update</contactName>
<operation>add_to or replace</operation>
<categories>comma-separated list of categories</categories>
<tags>comma-separated list of tags</tags>
<preferences>key1:value1,key2:value2</preferences>
<customFields>field1:value1,field2:value2</customFields>
<notes>Any additional notes</notes>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

// Room action templates
export const shouldFollowRoomTemplate = `# Task: Decide if {{agentName}} should start following this room, i.e. eagerly participating without explicit mentions.

{{recentMessages}}

Should {{agentName}} start following this room, eagerly participating without explicit mentions?
Respond with YES if:
- The user has directly asked {{agentName}} to follow the conversation or participate more actively
- The conversation topic is highly engaging and {{agentName}}'s input would add significant value
- {{agentName}} has unique insights to contribute and the users seem receptive

Otherwise, respond with NO.
Respond with only a YES or a NO.`;

export const shouldUnfollowRoomTemplate = `# Task: Decide if {{agentName}} should stop closely following this previously followed room and only respond when mentioned.

{{recentMessages}}

Should {{agentName}} stop closely following this previously followed room and only respond when mentioned?
Respond with YES if:
- The user has suggested that {{agentName}} is over-participating or being disruptive
- {{agentName}}'s eagerness to contribute is not well-received by the users
- The conversation has shifted to a topic where {{agentName}} has less to add

Otherwise, respond with NO.
Respond with only a YES or a NO.`;

export const shouldMuteRoomTemplate = `# Task: Decide if {{agentName}} should mute this room and stop responding unless explicitly mentioned.

{{recentMessages}}

Should {{agentName}} mute this room and stop responding unless explicitly mentioned?

Respond with YES if:
- The user is being aggressive, rude, or inappropriate
- The user has directly asked {{agentName}} to stop responding or be quiet
- {{agentName}}'s responses are not well-received or are annoying the user(s)

Otherwise, respond with NO.
Respond with only a YES or a NO.`;

export const shouldUnmuteRoomTemplate = `# Task: Decide if {{agentName}} should unmute this previously muted room and start considering it for responses again.

{{recentMessages}}

Should {{agentName}} unmute this previously muted room and start considering it for responses again?
Respond with YES if:
- The user has explicitly asked {{agentName}} to start responding again
- The user seems to want to re-engage with {{agentName}} in a respectful manner
- The tone of the conversation has improved and {{agentName}}'s input would be welcome

Otherwise, respond with NO.
Respond with only a YES or a NO.`;

// Target extraction template
export const targetExtractionTemplate = `# Task: Extract Target and Source Information

# Recent Messages:
{{recentMessages}}

# Instructions:
Analyze the conversation to identify:
1. The target type (user or room)
2. The target platform/source (e.g. telegram, discord, etc)
3. Any identifying information about the target
4. The message text to send

Return an XML response with:
<response>
  <targetType>user|room</targetType>
  <source>platform-name</source>
  <messageText>text_to_send</messageText>
  <identifiers>
    <username>username_if_applicable</username>
    <roomName>room_name_if_applicable</roomName>
  </identifiers>
</response>`;

// Update role template
export const updateRoleTemplate = `# Task: Update entity role in the world.

{{providers}}

# Current Role Assignments:
{{roles}}

# Instructions:
Based on the request, determine the role assignment to make.
Valid roles are: OWNER, ADMIN, MEMBER, GUEST, NONE

Respond using XML format like this:
<response>
    <thought>Your reasoning for the role change</thought>
    <entity_id>The entity ID to update</entity_id>
    <new_role>The new role to assign (OWNER, ADMIN, MEMBER, GUEST, or NONE)</new_role>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.`;

// Memory templates
export const initialSummarizationTemplate = `# Task: Summarize Conversation

You are analyzing a conversation to create a concise summary that captures the key points, topics, and important details.

# Recent Messages
{{recentMessages}}

# Instructions
Generate a summary that:
1. Captures the main topics discussed
2. Highlights key information shared
3. Notes any decisions made or questions asked
4. Maintains context for future reference
5. Is concise but comprehensive

**IMPORTANT**: Keep the summary under 2500 tokens. Be comprehensive but concise.

Also extract:
- **Topics**: List of main topics discussed (comma-separated)
- **Key Points**: Important facts or decisions (bullet points)

Respond in this XML format:
<summary>
  <text>Your comprehensive summary here</text>
  <topics>topic1, topic2, topic3</topics>
  <keyPoints>
    <point>First key point</point>
    <point>Second key point</point>
  </keyPoints>
</summary>`;

export const updateSummarizationTemplate = `# Task: Update and Condense Conversation Summary

You are updating an existing conversation summary with new messages, while keeping the total summary concise.

# Existing Summary
{{existingSummary}}

# Existing Topics
{{existingTopics}}

# New Messages Since Last Summary
{{newMessages}}

# Instructions
Update the summary by:
1. Merging the existing summary with insights from the new messages
2. Removing redundant or less important details to stay under the token limit
3. Keeping the most important context and decisions
4. Adding new topics if they emerge
5. **CRITICAL**: Keep the ENTIRE updated summary under 2500 tokens

The goal is a rolling summary that captures the essence of the conversation without growing indefinitely.

Respond in this XML format:
<summary>
  <text>Your updated and condensed summary here</text>
  <topics>topic1, topic2, topic3</topics>
  <keyPoints>
    <point>First key point</point>
    <point>Second key point</point>
  </keyPoints>
</summary>`;

export const longTermExtractionTemplate = `# Task: Extract Long-Term Memory (Strict Criteria)

You are analyzing a conversation to extract ONLY the most critical, persistent information about the user using cognitive science memory categories.

# Recent Messages
{{recentMessages}}

# Current Long-Term Memories
{{existingMemories}}

# ULTRA-STRICT EXTRACTION CRITERIA

Default to NOT extracting. Confidence must be >= 0.85.
If there are no qualifying facts, respond with <memories></memories>

# Response Format

<memories>
  <memory>
    <category>semantic</category>
    <content>User is a senior TypeScript developer with 8 years of backend experience</content>
    <confidence>0.95</confidence>
  </memory>
</memories>`;

export const messageClassifierTemplate = `Analyze this user request and classify it for planning purposes:

"{{text}}"

Classify the request across these dimensions:

1. COMPLEXITY LEVEL:
- simple: Direct actions that don't require planning
- medium: Multi-step tasks requiring coordination
- complex: Strategic initiatives with multiple stakeholders
- enterprise: Large-scale transformations with full complexity

2. PLANNING TYPE:
- direct_action: Single action, no planning needed
- sequential_planning: Multiple steps in sequence
- strategic_planning: Complex coordination with stakeholders

3. REQUIRED CAPABILITIES:
- List specific capabilities needed (analysis, communication, project_management, etc.)

4. STAKEHOLDERS:
- List types of people/groups involved

5. CONSTRAINTS:
- List limitations or requirements mentioned

6. DEPENDENCIES:
- List dependencies between tasks or external factors

Respond in this exact format:
COMPLEXITY: [simple|medium|complex|enterprise]
PLANNING: [direct_action|sequential_planning|strategic_planning]
CAPABILITIES: [comma-separated list]
STAKEHOLDERS: [comma-separated list]
CONSTRAINTS: [comma-separated list]
DEPENDENCIES: [comma-separated list]
CONFIDENCE: [0.0-1.0]`;

// UPPERCASE aliases for action templates
export const SCHEDULE_FOLLOW_UP_TEMPLATE = scheduleFollowUpTemplate;
export const ADD_CONTACT_TEMPLATE = addContactTemplate;
export const SEARCH_CONTACTS_TEMPLATE = searchContactsTemplate;
export const REMOVE_CONTACT_TEMPLATE = removeContactTemplate;
export const UPDATE_CONTACT_TEMPLATE = updateContactTemplate;
export const SHOULD_FOLLOW_ROOM_TEMPLATE = shouldFollowRoomTemplate;
export const SHOULD_UNFOLLOW_ROOM_TEMPLATE = shouldUnfollowRoomTemplate;
export const SHOULD_MUTE_ROOM_TEMPLATE = shouldMuteRoomTemplate;
export const SHOULD_UNMUTE_ROOM_TEMPLATE = shouldUnmuteRoomTemplate;
// Legacy aliases without _ROOM_ suffix for backwards compatibility
export const shouldFollowTemplate = shouldFollowRoomTemplate;
export const shouldUnfollowTemplate = shouldUnfollowRoomTemplate;
export const shouldMuteTemplate = shouldMuteRoomTemplate;
export const shouldUnmuteTemplate = shouldUnmuteRoomTemplate;
export const TARGET_EXTRACTION_TEMPLATE = targetExtractionTemplate;
export const UPDATE_ROLE_TEMPLATE = updateRoleTemplate;
export const INITIAL_SUMMARIZATION_TEMPLATE = initialSummarizationTemplate;
export const UPDATE_SUMMARIZATION_TEMPLATE = updateSummarizationTemplate;
export const LONG_TERM_EXTRACTION_TEMPLATE = longTermExtractionTemplate;
export const MESSAGE_CLASSIFIER_TEMPLATE = messageClassifierTemplate;

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

// Entity resolution template
export const entityResolutionTemplate = `# Task: Resolve Entity Name
Message Sender: {{senderName}} (ID: {{senderId}})
Agent: {{agentName}} (ID: {{agentId}})

# Entities in Room:
{{#if entitiesInRoom}}
{{entitiesInRoom}}
{{/if}}

{{recentMessages}}

# Instructions:
1. Analyze the context to identify which entity is being referenced
2. Consider special references like "me" (the message sender) or "you" (agent the message is directed to)
3. Look for usernames/handles in standard formats (e.g. @username, user#1234)
4. Consider context from recent messages for pronouns and references
5. If multiple matches exist, use context to disambiguate
6. Consider recent interactions and relationship strength when resolving ambiguity

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Return an XML response with:
<response>
  <entityId>exact-id-if-known-otherwise-null</entityId>
  <type>EXACT_MATCH | USERNAME_MATCH | NAME_MATCH | RELATIONSHIP_MATCH | AMBIGUOUS | UNKNOWN</type>
  <matches>
    <match>
      <name>matched-name</name>
      <reason>why this entity matches</reason>
    </match>
  </matches>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.`;

// Component extraction template
export const componentTemplate = `# Task: Extract Source and Update Component Data

{{recentMessages}}

{{#if existingData}}
# Existing Component Data:
{{existingData}}
{{/if}}

# Instructions:
1. Analyze the conversation to identify:
   - The source/platform being referenced (e.g. telegram, x, discord)
   - Any specific component data being shared

2. Generate updated component data that:
   - Is specific to the identified platform/source
   - Preserves existing data when appropriate
   - Includes the new information from the conversation
   - Contains only valid data for this component type

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Return an XML response with the following structure:
<response>
  <source>platform-name</source>
  <data>
    <username>username_value</username>
    <displayName>display_name_value</displayName>
  </data>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.`;

// Settings response templates
export const settingsSuccessTemplate = `# Task: Generate a response for successful setting updates
{{providers}}

# Update Information:
- Updated Settings: {{updateMessages}}
- Next Required Setting: {{nextSetting.name}}
- Remaining Required Settings: {{remainingRequired}}

# Instructions:
1. Acknowledge the successful update of settings
2. Maintain {{agentName}}'s personality and tone
3. Provide clear guidance on the next setting that needs to be configured
4. Explain what the next setting is for and how to set it
5. If appropriate, mention how many required settings remain

Write a natural, conversational response that {{agentName}} would send about the successful update and next steps.
Include the actions array ["SETTING_UPDATED"] in your response.`;

export const settingsFailureTemplate = `# Task: Generate a response for failed setting updates

# About {{agentName}}:
{{bio}}

# Current Settings Status:
{{settingsStatus}}

# Next Required Setting:
- Name: {{nextSetting.name}}
- Description: {{nextSetting.description}}
- Required: Yes
- Remaining Required Settings: {{remainingRequired}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Express that you couldn't understand or process the setting update
2. Maintain {{agentName}}'s personality and tone
3. Provide clear guidance on what setting needs to be configured next
4. Explain what the setting is for and how to set it properly
5. Use a helpful, patient tone

Write a natural, conversational response that {{agentName}} would send about the failed update and how to proceed.
Include the actions array ["SETTING_UPDATE_FAILED"] in your response.`;

export const settingsErrorTemplate = `# Task: Generate a response for an error during setting updates

# About {{agentName}}:
{{bio}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Apologize for the technical difficulty
2. Maintain {{agentName}}'s personality and tone
3. Suggest trying again or contacting support if the issue persists
4. Keep the message concise and helpful

Write a natural, conversational response that {{agentName}} would send about the error.
Include the actions array ["SETTING_UPDATE_ERROR"] in your response.`;

export const settingsCompletionTemplate = `# Task: Generate a response for settings completion

# About {{agentName}}:
{{bio}}

# Settings Status:
{{settingsStatus}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Congratulate the user on completing the settings process
2. Maintain {{agentName}}'s personality and tone
3. Summarize the key settings that have been configured
4. Explain what functionality is now available
5. Provide guidance on what the user can do next
6. Express enthusiasm about working together

Write a natural, conversational response that {{agentName}} would send about the successful completion of settings.
Include the actions array ["ONBOARDING_COMPLETE"] in your response.`;

// UPPERCASE aliases for new templates
export const ENTITY_RESOLUTION_TEMPLATE = entityResolutionTemplate;
export const COMPONENT_TEMPLATE = componentTemplate;
export const SETTINGS_SUCCESS_TEMPLATE = settingsSuccessTemplate;
export const SETTINGS_FAILURE_TEMPLATE = settingsFailureTemplate;
export const SETTINGS_ERROR_TEMPLATE = settingsErrorTemplate;
export const SETTINGS_COMPLETION_TEMPLATE = settingsCompletionTemplate;

// Autonomy templates
export const autonomyContinuousFirstTemplate = `You are running in AUTONOMOUS CONTINUOUS MODE.

Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- If you cannot act, state the missing info and the safest next step to obtain it.
- Keep the response concise, focused on the next action.

USER CONTEXT (most recent last):
{{targetRoomContext}}

Think briefly, then state what you want to do next and take action if needed.`;

export const autonomyContinuousContinueTemplate = `You are running in AUTONOMOUS CONTINUOUS MODE.

Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- If you cannot act, state the missing info and the safest next step to obtain it.
- Keep the response concise, focused on the next action.

USER CONTEXT (most recent last):
{{targetRoomContext}}

Your last autonomous note: "{{lastThought}}"

Continue from that note. Decide the next step and act if needed.`;

export const autonomyTaskFirstTemplate = `You are running in AUTONOMOUS TASK MODE.

Your job: continue helping the user and make progress toward the task.
- Use available actions/tools to gather information or execute steps.
- If you need UI control, use ComputerUse actions.
- In MCP mode, selector-based actions require a process scope (pass process=... or prefix selector with "process:<name> >> ...").
- Prefer safe, incremental steps; if unsure, gather more UI context before acting.

USER CHAT CONTEXT (most recent last):
{{targetRoomContext}}

Decide what to do next. Think briefly, then take the most useful action.`;

export const autonomyTaskContinueTemplate = `You are running in AUTONOMOUS TASK MODE.

Your job: continue helping the user and make progress toward the task.
- Use available actions/tools to gather information or execute steps.
- If you need UI control, use ComputerUse actions.
- In MCP mode, selector-based actions require a process scope (pass process=... or prefix selector with "process:<name> >> ...").
- Prefer safe, incremental steps; if unsure, gather more UI context before acting.

USER CHAT CONTEXT (most recent last):
{{targetRoomContext}}

Your last autonomous note: "{{lastThought}}"

Continue the task. Decide the next step and take action now.`;

// UPPERCASE aliases for autonomy templates
export const AUTONOMY_CONTINUOUS_FIRST_TEMPLATE =
  autonomyContinuousFirstTemplate;
export const AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE =
  autonomyContinuousContinueTemplate;
export const AUTONOMY_TASK_FIRST_TEMPLATE = autonomyTaskFirstTemplate;
export const AUTONOMY_TASK_CONTINUE_TEMPLATE = autonomyTaskContinueTemplate;
