//! Prompt templates for elizaOS Rust runtime.
//!
//! NOTE: These prompts are sourced from the shared @elizaos/prompts package.
//! To modify prompts, edit the .txt files in packages/prompts/prompts/ and run:
//!   cd packages/prompts && npm run build
//!
//! These prompts use Handlebars-style template syntax:
//! - {{variableName}} for simple substitution
//! - {{#each items}}...{{/each}} for iteration
//! - {{#if condition}}...{{/if}} for conditionals

/// Template for generating agent reply messages.
pub const REPLY_TEMPLATE: &str = r#"# Task: Generate dialog for the character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.
"thought" should be a short description of what the agent is thinking about and planning.
"text" should be the next message for {{agentName}} which they will send to the conversation.

IMPORTANT CODE BLOCK FORMATTING RULES:
- If {{agentName}} includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with ``` fenced code blocks (specify the language if known, e.g., ```python).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text, instructions, or single words in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (`) as appropriate.
- This ensures the user sees clearly formatted and copyable code when relevant.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <text>Your message here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>."#;

/// Template for choosing from available options.
pub const CHOOSE_OPTION_TEMPLATE: &str = r#"# Task: Choose an option from the available choices.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for generating image prompts.
pub const IMAGE_GENERATION_TEMPLATE: &str = r#"# Task: Generate an image prompt for {{agentName}}.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for agent self-reflection and improvement.
pub const REFLECTION_TEMPLATE: &str = r#"# Task: Reflect on recent agent behavior and interactions.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for updating agent settings.
pub const UPDATE_SETTINGS_TEMPLATE: &str = r#"# Task: Update settings based on the request.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for updating entity information.
pub const UPDATE_ENTITY_TEMPLATE: &str = r#"# Task: Update entity information.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for deciding whether the agent should respond.
pub const SHOULD_RESPOND_TEMPLATE: &str = r#"<task>Decide on behalf of {{agentName}} whether they should respond to the message, ignore it or stop the conversation.</task>

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
</output>"#;

/// Template for handling messages and generating actions.
pub const MESSAGE_HANDLER_TEMPLATE: &str = r#"<task>Generate dialog and actions for the character {{agentName}}.</task>

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
- If {{agentName}} includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with ``` fenced code blocks (specify the language if known, e.g., ```python).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text, instructions, or single words in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (`) as appropriate.
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

Note: The <params> block is optional and should only be included when actions require input parameters.
If an action has no parameters or you're only using REPLY/IGNORE, omit the <params> block entirely.

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
</output>"#;

/// Template for multi-step decision making (iterative workflow).
pub const MULTI_STEP_DECISION_TEMPLATE: &str = r#"<task>
Determine the next step the assistant should take in this conversation to help the user reach their goal.
</task>

{{recentMessages}}

# Multi-Step Workflow

In each step, decide:

1. **Which providers (if any)** should be called to gather necessary data.
2. **Which action (if any)** should be executed after providers return.
3. Decide whether the task is complete. If so, set `isFinish: true`. Do not select the `REPLY` action; replies are handled separately after task completion.

You can select **multiple providers** and at most **one action** per step.

If the task is fully resolved and no further steps are needed, mark the step as `isFinish: true`.

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

⚠️ IMPORTANT: Do **not** mark the task as `isFinish: true` immediately after calling an action. Wait for the action to complete before deciding the task is finished.

<output>
<response>
  <thought>Your thought here</thought>
  <action>ACTION</action>
  <providers>PROVIDER1,PROVIDER2</providers>
  <isFinish>true | false</isFinish>
</response>
</output>"#;

/// Template for multi-step final summary.
pub const MULTI_STEP_SUMMARY_TEMPLATE: &str = r#"<task>
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
"#;

/// Template for autonomous continuous mode (first thought).
pub const AUTONOMY_CONTINUOUS_FIRST_TEMPLATE: &str = r#"You are running in AUTONOMOUS CONTINUOUS MODE.

Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- If you cannot act, state the missing info and the safest next step to obtain it.
- Keep the response concise, focused on the next action.

USER CONTEXT (most recent last):
{{targetRoomContext}}

Think briefly, then state what you want to do next and take action if needed.
"#;

/// Template for autonomous continuous mode (continuation).
pub const AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE: &str = r#"You are running in AUTONOMOUS CONTINUOUS MODE.

Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- If you cannot act, state the missing info and the safest next step to obtain it.
- Keep the response concise, focused on the next action.

USER CONTEXT (most recent last):
{{targetRoomContext}}

Your last autonomous note: "{{lastThought}}"

Continue from that note. Decide the next step and act if needed.
"#;

/// Template for autonomous task mode (first thought).
pub const AUTONOMY_TASK_FIRST_TEMPLATE: &str = r#"You are running in AUTONOMOUS TASK MODE.

Your job: continue helping the user and make progress toward the task.
- Use available actions/tools to gather information or execute steps.
- If you need UI control, use ComputerUse actions.
- In MCP mode, selector-based actions require a process scope (pass process=... or prefix selector with "process:<name> >> ...").
- Prefer safe, incremental steps; if unsure, gather more UI context before acting.

USER CHAT CONTEXT (most recent last):
{{targetRoomContext}}

Decide what to do next. Think briefly, then take the most useful action.
"#;

/// Template for autonomous task mode (continuation).
pub const AUTONOMY_TASK_CONTINUE_TEMPLATE: &str = r#"You are running in AUTONOMOUS TASK MODE.

Your job: continue helping the user and make progress toward the task.
- Use available actions/tools to gather information or execute steps.
- If you need UI control, use ComputerUse actions.
- In MCP mode, selector-based actions require a process scope (pass process=... or prefix selector with "process:<name> >> ...").
- Prefer safe, incremental steps; if unsure, gather more UI context before acting.

USER CHAT CONTEXT (most recent last):
{{targetRoomContext}}

Your last autonomous note: "{{lastThought}}"

Continue the task. Decide the next step and take action now.
"#;

/// Footer for boolean yes/no responses.
pub const BOOLEAN_FOOTER: &str = "Respond with only a YES or a NO.";

/// Template for classifying messages by complexity and planning requirements.
pub const MESSAGE_CLASSIFIER_TEMPLATE: &str = r#"Analyze this user request and classify it for planning purposes:

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
CONFIDENCE: [0.0-1.0]"#;

/// Template for initial conversation summarization.
pub const INITIAL_SUMMARIZATION_TEMPLATE: &str = r#"# Task: Summarize Conversation

# Recent Messages
{{recentMessages}}

Respond in this XML format:
<summary>
  <text>Your summary</text>
  <topics>topic1, topic2</topics>
  <keyPoints>
    <point>Key point</point>
  </keyPoints>
</summary>
"#;

/// Template for updating existing conversation summaries.
pub const UPDATE_SUMMARIZATION_TEMPLATE: &str = r#"# Task: Update and Condense Conversation Summary

# Existing Summary
{{existingSummary}}

# Existing Topics
{{existingTopics}}

# New Messages Since Last Summary
{{newMessages}}

Respond in this XML format:
<summary>
  <text>Your updated summary</text>
  <topics>topic1, topic2</topics>
  <keyPoints>
    <point>Key point</point>
  </keyPoints>
</summary>
"#;

/// Template for extracting long-term memories from conversations.
pub const LONG_TERM_EXTRACTION_TEMPLATE: &str = r#"# Task: Extract Long-Term Memory (Strict Criteria)

# Recent Messages
{{recentMessages}}

# Current Long-Term Memories
{{existingMemories}}

If there are no qualifying facts, respond with <memories></memories>.

<memories>
  <memory>
    <category>semantic</category>
    <content>User prefers concise answers</content>
    <confidence>0.95</confidence>
  </memory>
</memories>
"#;

/// Template for updating entity roles in the world.
pub const UPDATE_ROLE_TEMPLATE: &str = r#"# Task: Update entity role in the world.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for scheduling follow-ups with contacts.
pub const SCHEDULE_FOLLOW_UP_TEMPLATE: &str = r#"# Task: Schedule a follow-up reminder.

{{providers}}

# Current Message Context:
{{message}}
Sender: {{senderName}} ({{senderId}})
Current Time: {{currentDateTime}}

# Instructions:
Extract follow-up details from the conversation. Determine:
1. When the follow-up should occur
2. The reason for following up
3. An optional message to include

Respond using XML format like this:
<response>
    <thought>Your reasoning for the follow-up</thought>
    <entity_id>Entity ID to follow up with</entity_id>
    <scheduled_for>ISO 8601 datetime for follow-up</scheduled_for>
    <reason>Reason for follow-up</reason>
    <message>Optional message to include</message>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for adding contacts to the rolodex.
pub const ADD_CONTACT_TEMPLATE: &str = r#"# Task: Add a contact to the rolodex.

{{providers}}

# Current Message Context:
{{message}}
Sender: {{senderName}} ({{senderId}})

# Instructions:
Extract contact information from the conversation. Look for:
1. Name or identifier
2. Category/relationship type
3. Any notes or context

Respond using XML format like this:
<response>
    <thought>Your reasoning for adding this contact</thought>
    <name>Contact name</name>
    <category>Contact category</category>
    <notes>Additional notes</notes>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for searching contacts in the rolodex.
pub const SEARCH_CONTACTS_TEMPLATE: &str = r#"# Task: Search for contacts in the rolodex.

{{providers}}

# Current Message Context:
{{message}}
Sender: {{senderName}} ({{senderId}})

# Instructions:
Determine what the user is searching for in their contacts.
Extract search criteria from the conversation.

Respond using XML format like this:
<response>
    <thought>Your understanding of the search request</thought>
    <query>Search query or criteria</query>
    <category>Optional category filter</category>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for removing contacts from the rolodex.
pub const REMOVE_CONTACT_TEMPLATE: &str = r#"# Task: Remove a contact from the rolodex.

{{providers}}

# Current Message Context:
{{message}}
Sender: {{senderName}} ({{senderId}})

# Instructions:
Determine which contact should be removed based on the conversation.

Respond using XML format like this:
<response>
    <thought>Your reasoning for removing this contact</thought>
    <entity_id>Entity ID to remove</entity_id>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for updating contact information.
pub const UPDATE_CONTACT_TEMPLATE: &str = r#"# Task: Update contact information.

{{providers}}

# Current Message Context:
{{message}}
Sender: {{senderName}} ({{senderId}})

# Instructions:
Determine what contact information should be updated based on the conversation.

Respond using XML format like this:
<response>
    <thought>Your reasoning for the update</thought>
    <entity_id>Entity ID to update</entity_id>
    <updates>
        <field>
            <name>field_name</name>
            <value>new_value</value>
        </field>
    </updates>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for deciding if agent should follow a room.
pub const SHOULD_FOLLOW_ROOM_TEMPLATE: &str = r#"# Task: Decide if the agent should follow this room.

{{providers}}

# Instructions:
Based on the conversation context, determine if the agent should follow this room
to receive notifications about future messages.

Respond using XML format like this:
<response>
    <thought>Your reasoning</thought>
    <should_follow>true or false</should_follow>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for deciding if agent should unfollow a room.
pub const SHOULD_UNFOLLOW_ROOM_TEMPLATE: &str = r#"# Task: Decide if the agent should unfollow this room.

{{providers}}

# Instructions:
Based on the conversation context, determine if the agent should unfollow this room
to stop receiving notifications.

Respond using XML format like this:
<response>
    <thought>Your reasoning</thought>
    <should_unfollow>true or false</should_unfollow>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for deciding if agent should mute a room.
pub const SHOULD_MUTE_ROOM_TEMPLATE: &str = r#"# Task: Decide if the agent should mute this room.

{{providers}}

# Instructions:
Based on the conversation context, determine if the agent should mute this room.

Respond using XML format like this:
<response>
    <thought>Your reasoning</thought>
    <should_mute>true or false</should_mute>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for deciding if agent should unmute a room.
pub const SHOULD_UNMUTE_ROOM_TEMPLATE: &str = r#"# Task: Decide if the agent should unmute this room.

{{providers}}

# Instructions:
Based on the conversation context, determine if the agent should unmute this room.

Respond using XML format like this:
<response>
    <thought>Your reasoning</thought>
    <should_unmute>true or false</should_unmute>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for extracting target and source for sending messages.
pub const TARGET_EXTRACTION_TEMPLATE: &str = r#"# Task: Extract target and source for sending a message.

{{providers}}

# Instructions:
From the conversation, extract:
1. The target (user or room) to send the message to
2. The platform/source to use
3. The message content

Respond using XML format like this:
<response>
    <thought>Your reasoning</thought>
    <target_type>user or room</target_type>
    <target>Target identifier</target>
    <source>Platform/source</source>
    <message>Message content</message>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for resolving entity names from context.
pub const ENTITY_RESOLUTION_TEMPLATE: &str = r#"# Task: Resolve Entity Name
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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for extracting component data from conversations.
pub const COMPONENT_TEMPLATE: &str = r#"# Task: Extract Source and Update Component Data

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for successful settings update response.
pub const SETTINGS_SUCCESS_TEMPLATE: &str = r#"# Task: Generate a response for successful setting updates
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
Include the actions array ["SETTING_UPDATED"] in your response."#;

/// Template for failed settings update response.
pub const SETTINGS_FAILURE_TEMPLATE: &str = r#"# Task: Generate a response for failed setting updates

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
Include the actions array ["SETTING_UPDATE_FAILED"] in your response."#;

/// Template for settings error response.
pub const SETTINGS_ERROR_TEMPLATE: &str = r#"# Task: Generate a response for an error during setting updates

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
Include the actions array ["SETTING_UPDATE_ERROR"] in your response."#;

/// Template for settings completion response.
pub const SETTINGS_COMPLETION_TEMPLATE: &str = r#"# Task: Generate a response for settings completion

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
Include the actions array ["ONBOARDING_COMPLETE"] in your response."#;

/// Template for creating social media posts.
pub const POST_CREATION_TEMPLATE: &str = r#"# Task: Create a post in the voice and style and perspective of {{agentName}} @{{xUserName}}.

{{providers}}

Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 280. No emojis. Use \n\n (double spaces) between statements if there are multiple statements in your response.

Your output should be formatted in XML like this:
<response>
  <thought>Your thought here</thought>
  <post>Your post text here</post>
  <imagePrompt>Optional image prompt here</imagePrompt>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for describing images.
pub const IMAGE_DESCRIPTION_TEMPLATE: &str = r#"<task>Analyze the provided image and generate a comprehensive description with multiple levels of detail.</task>

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.
</output>"#;

/// Template for extracting task option selections.
pub const OPTION_EXTRACTION_TEMPLATE: &str = r#"# Task: Extract selected task and option from user message

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Template for evaluator reflection with facts and relationships.
pub const REFLECTION_EVALUATOR_TEMPLATE: &str = r#"# Task: Generate Agent Reflection, Extract Facts and Relationships

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
  </facts>
  <relationships>
    <relationship>
      <sourceEntityId>entity_initiating_interaction</sourceEntityId>
      <targetEntityId>entity_being_interacted_with</targetEntityId>
      <tags>group_interaction,voice_interaction,dm_interaction,additional_tag1,additional_tag2</tags>
    </relationship>
  </relationships>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;
