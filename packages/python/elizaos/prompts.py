from __future__ import annotations

REPLY_TEMPLATE = """# Task: Generate dialog for the character {{agentName}}.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>."""

CHOOSE_OPTION_TEMPLATE = """# Task: Choose an option from the available choices.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""

IMAGE_GENERATION_TEMPLATE = """# Task: Generate an image prompt for {{agentName}}.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""

REFLECTION_TEMPLATE = """# Task: Reflect on recent agent behavior and interactions.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""

UPDATE_SETTINGS_TEMPLATE = """# Task: Update settings based on the request.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""

UPDATE_ENTITY_TEMPLATE = """# Task: Update entity information.

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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""

SHOULD_RESPOND_TEMPLATE = """<task>Decide on behalf of {{agentName}} whether they should respond to the message, ignore it or stop the conversation.</task>

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
</output>"""

MESSAGE_HANDLER_TEMPLATE = """<task>Generate dialog and actions for the character {{agentName}}.</task>

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
</output>"""

BOOLEAN_FOOTER = "Respond with only a YES or a NO."

__all__ = [
    "REPLY_TEMPLATE",
    "CHOOSE_OPTION_TEMPLATE",
    "IMAGE_GENERATION_TEMPLATE",
    "REFLECTION_TEMPLATE",
    "UPDATE_SETTINGS_TEMPLATE",
    "UPDATE_ENTITY_TEMPLATE",
    "SHOULD_RESPOND_TEMPLATE",
    "MESSAGE_HANDLER_TEMPLATE",
    "BOOLEAN_FOOTER",
]
