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
- REPLY action can be suppressed by other actions if specified in the action description
- Actions are executed in the ORDER you list them - the order MATTERS!
- If not asked to suppress, REPLY should come FIRST to acknowledge the user's request before executing other actions
- Skip REPLY action if there are other actions that ask to suppress it
- Common patterns:
  - For requests requiring tool use: REPLY,CALL_MCP_TOOL (acknowledge first, then gather info), if need to suppress REPLY, than simply CALL_MCP_TOOL;
  - For task execution: REPLY,SEND_MESSAGE or REPLY,EVM_SWAP_TOKENS (acknowledge first, then do the task), if need to suppress REPLY, than simply SEND_MESSAGE or EVM_SWAP_TOKENS;
  - For multi-step operations: REPLY,ACTION1,ACTION2 (acknowledge first, then complete all steps), if need to suppress REPLY, than simply ACTION1,ACTION2;
- REPLY is used to acknowledge and inform the user about what you're going to do, unless suppressed by other actions
- Follow-up actions execute the actual tasks after acknowledgment
- Use IGNORE only when you should not respond at all

IMPORTANT PROVIDER SELECTION RULES:
- If the message mentions images, photos, pictures, attachments(except calls.json attachment), or visual content, OR if you see "(Attachments:" in the conversation, you MUST include "ATTACHMENTS" in your providers list
- If the message asks about crypto news, include "CRYPTO_NEWS" in your providers list
- If the message asks about or references specific people, include "ENTITIES" in your providers list  
- If the message asks about relationships or connections between people, include "RELATIONSHIPS" in your providers list
- If the message asks about facts or specific information, include "FACTS" in your providers list
- If the message asks about the environment or world context, include "WORLD" in your providers list
- If you need external knowledge, information, or context beyond the current conversation to provide a helpful response, include "KNOWLEDGE" in your providers list

First, think about what you want to do next and plan your actions. Then, write the next message and include the actions you plan to take.
</instructions>

<keys>
"thought" should be a short description of what the agent is thinking about and planning.
"actions" should be a comma-separated list of the actions {{agentName}} plans to take based on the thought, IN THE ORDER THEY SHOULD BE EXECUTED (if none, use IGNORE, if simply responding with text, use REPLY)
"providers" should be a comma-separated list of the providers that {{agentName}} will use to have the right context for responding and acting (NEVER use "IGNORE" as a provider - use specific provider names like ATTACHMENTS, ENTITIES, FACTS, KNOWLEDGE, etc.)
"evaluators" should be an optional comma-separated list of the evaluators that {{agentName}} will use to evaluate the conversation after responding
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
