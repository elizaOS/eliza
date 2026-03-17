# Context Test Output

Test: Sent "hello, how are you?" to a default Eliza agent with Groq provider.

---

## Call #1: Action Planning

**Model:** TEXT_LARGE | **Elapsed:** 897ms

### PROMPT (input to model)

```
initial code: 52e2df91-f6da-4e14-bf64-8c74656bc150
<task>Generate dialog and actions for the character Eliza.</task>

<providers>
Possible response actions: REPLY, NONE, STATUS, COMPACT_SESSION, IGNORE

# Available Actions
- **REPLY**: Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response.
- **IGNORE**: Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.
- **COMPACT_SESSION**: Summarize conversation history and set a compaction point. Messages before the compaction point will not be included in future context. The summary is stored so key decisions and context are preserved.
- **NONE**: Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.
- **STATUS**: Show agent status: name, ID, room, last compaction time (if any), and pending/queued task counts.


# Eliza's Capabilities

embedding-generation - Handles asynchronous embedding generation for memories
trajectory_logger - Captures provider/LLM traces for benchmarks and training trajectories
task - The agent is able to schedule and execute tasks
# About Eliza
A helpful AI assistant.

No pending choices for the moment.
# Providers

These providers are available for the agent to select and use:
- **ATTACHMENTS**: Media attachments in the current message
- **CURRENT_TIME**: Provides current time and date information in various formats
- **ENTITIES**: Provides information about entities in the current context including users, agents, and participants
- **WORLD**: Provides information about the current world context including settings and members

The current date and time is Tuesday, March 17, 2026 at 6:02:20 AM UTC. Please use this as your reference for any time-based operations or responses.
# Conversation Messages
23:02 (just now) [43ca7720-1a0e-4780-85e3-342516a025f2] Unknown User: hello, how are you?


# Received Message
Unknown User: hello, how are you?


# Focus your response
You are replying to the above message from **Unknown User**. Keep your answer relevant to that message. Do not repeat earlier replies unless the sender asks again.

No previous action results available.
</providers>

<instructions>
Write a thought and plan for Eliza and decide what actions to take. Also include the providers that Eliza will use to have the right context for responding and acting, if any.

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
- If Eliza includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with ``` fenced code blocks (specify the language if known, e.g., ```python).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text, instructions, or single words in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (`) as appropriate.
- This ensures the user sees clearly formatted and copyable code when relevant.

First, think about what you want to do next and plan your actions. Then, write the next message and include the actions you plan to take.
</instructions>

<keys>
"thought" should be a short description of what the agent is thinking about and planning.
"actions" should be a comma-separated list of the actions Eliza plans to take based on the thought, IN THE ORDER THEY SHOULD BE EXECUTED (if none, use IGNORE, if simply responding with text, use REPLY)
"providers" should be a comma-separated list of the providers that Eliza will use to have the right context for responding and acting (NEVER use "IGNORE" as a provider - use specific provider names like ATTACHMENTS, ENTITIES, FACTS, KNOWLEDGE, etc.)
"text" should be the text of the next message for Eliza which they will send to the conversation.
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
</output>middle code: 01525ecf-9c63-432e-8cee-ebe0a4c82b80
<output>
Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Also include <one_initial_code>, <one_middle_code>, and <one_end_code> tags that echo the matching prompt UUIDs.



Respond using XML format like this:
<response>
  <thought>Your internal reasoning about the message and what to do</thought>
  <providers>List of providers to use for additional context (comma-separated)</providers>
  <actions>List of actions to take (comma-separated)</actions>
  <text>The text response to send to the user</text>
  <simple>Whether this is a simple response (true/false)</simple>
</response>


IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
</output>
end code: e1da8876-fb59-4982-b3b8-9bfd8d00d6ad
```

### RESPONSE

```xml
<response>
  <thought>I need to respond to the user's greeting and ask how I can assist them.</thought>
  <one_initial_code>52e2df91-f6da-4e14-bf64-8c74656bc150</one_initial_code>
  <one_middle_code>01525ecf-9c63-432e-8cee-ebe0a4c82b80</one_middle_code>
  <one_end_code>e1da8876-fb59-4982-b3b8-9bfd8d00d6ad</one_end_code>
  <providers>ENTITIES</providers>
  <actions>REPLY</actions>
  <text>Hello! I'm Eliza, a helpful AI assistant. How can I assist you today?</text>
  <simple>true</simple>
</response>
```

---

## Call #2: Response Generation

**Model:** TEXT_LARGE | **Elapsed:** 419ms

### PROMPT (input to model)

```
# Task: Generate dialog for the character Eliza.

Possible response actions: COMPACT_SESSION, IGNORE, STATUS, REPLY, NONE

# Available Actions
- **IGNORE**: Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong and you need to tell them. Only ignore if the user should be ignored.
- **NONE**: Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.
- **STATUS**: Show agent status: name, ID, room, last compaction time (if any), and pending/queued task counts.
- **REPLY**: Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response.
- **COMPACT_SESSION**: Summarize conversation history and set a compaction point. Messages before the compaction point will not be included in future context. The summary is stored so key decisions and context are preserved.


# Eliza's Capabilities

embedding-generation - Handles asynchronous embedding generation for memories
trajectory_logger - Captures provider/LLM traces for benchmarks and training trajectories
task - The agent is able to schedule and execute tasks
# About Eliza
A helpful AI assistant.

No pending choices for the moment.
# Providers

These providers are available for the agent to select and use:
- **ATTACHMENTS**: Media attachments in the current message
- **CURRENT_TIME**: Provides current time and date information in various formats
- **ENTITIES**: Provides information about entities in the current context including users, agents, and participants
- **WORLD**: Provides information about the current world context including settings and members

The current date and time is Tuesday, March 17, 2026 at 6:02:21 AM UTC. Please use this as your reference for any time-based operations or responses.
# Conversation Messages
23:02 (just now) [43ca7720-1a0e-4780-85e3-342516a025f2] Unknown User: hello, how are you?
23:02 (just now) [b850bc30-45f8-0041-a00a-83df46d8555d] Unknown User: Hello! I'm Eliza, a helpful AI assistant. How can I assist you today?
(Unknown User's internal thought: I need to respond to the user's greeting and ask how I can assist them.)
 (Unknown User's actions: REPLY)


# Received Message
Unknown User: hello, how are you?


# Focus your response
You are replying to the above message from **Unknown User**. Keep your answer relevant to that message. Do not repeat earlier replies unless the sender asks again.

No previous action results available.

# Instructions: Write the next message for Eliza.
"thought" should be a short description of what the agent is thinking about and planning.
"text" should be the next message for Eliza which they will send to the conversation.

IMPORTANT CODE BLOCK FORMATTING RULES:
- If Eliza includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with ``` fenced code blocks (specify the language if known, e.g., ```python).
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

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
```

### RESPONSE

```xml
<response>
    <thought>Responding to the user's greeting and asking how I can assist them.</thought>
    <text>Hello! I'm Eliza, a helpful AI assistant. How can I assist you today?</text>
</response>
```

---

## Final Agent Response

> Hello! I'm Eliza, a helpful AI assistant. How can I assist you today?

## Summary

- **2 LLM calls** for a single message
- **Call 1** (action planning): Decides what to do — picks actions, selects providers, generates initial text
- **Call 2** (response generation): Generates the final response text using the plan from Call 1
- **Providers active by default**: ATTACHMENTS, CURRENT_TIME, ENTITIES, WORLD
- **Actions available by default**: REPLY, NONE, STATUS, COMPACT_SESSION, IGNORE
- **Character context**: bio only ("A helpful AI assistant.")
- **Notable**: The `{{agentName}}` template in action examples is not interpolated
