//! Auto-generated prompt templates for elizaOS Rust runtime.
//! DO NOT EDIT - Generated from packages/prompts/prompts/*.txt
//!
//! These prompts use Handlebars-style template syntax:
//! - {{variableName}} for simple substitution
//! - {{#each items}}...{{/each}} for iteration
//! - {{#if condition}}...{{/if}} for conditionals

#![allow(missing_docs)]

pub const ADD_CONTACT_TEMPLATE: &str = r#"task: Extract contact information to add to the relationships.

context:
{{providers}}

recent_messages:
{{recentMessages}}

current_message:
{{message}}

instructions[5]:
- identify the contact name being added
- include entityId only if it is explicitly known from context
- return categories as a comma-separated list
- include notes, timezone, and language only when clearly present
- include a short reason for why this contact should be saved

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
contactName: Jane Doe
entityId:
categories: vip,colleague
notes: Met at the design summit
timezone: America/New_York
language: English
reason: Important collaborator to remember"#;

pub const AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE: &str = r#"Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- Use thinking to think about and plan what you want to do.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: ONLY a <thought> plus any actions. No other message text.
- If you don't need to make a change this round, take no action and output only a <thought>.
- If you cannot act, explain what is missing inside <thought> and take no action.
- Keep the response concise, focused on the next action.

USER CONTEXT (most recent last):
{{targetRoomContext}}

Your last autonomous note: "{{lastThought}}"

Continue from that note. Output <thought> and take action if needed."#;

pub const AUTONOMY_CONTINUOUS_FIRST_TEMPLATE: &str = r#"Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- Use thinking to think about and plan what you want to do.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: ONLY a <thought> plus any actions. No other message text.
- If you don't need to make a change this round, take no action and output only a <thought>.
- If you cannot act, explain what is missing inside <thought> and take no action.
- Keep the response concise, focused on the next action.

USER CONTEXT (most recent last):
{{targetRoomContext}}

Think briefly, then output <thought> and take action if needed."#;

pub const AUTONOMY_TASK_CONTINUE_TEMPLATE: &str = r#"You are running in AUTONOMOUS TASK MODE.

Your job: continue helping the user and make progress toward the task.
- Use available actions/tools to gather information or execute steps.
- Use thinking to think about and plan what you want to do.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: ONLY a <thought> plus any actions. No other message text.
- If you don't need to make a change this round, take no action and output only a <thought>.
- If you cannot act, explain what is missing inside <thought> and take no action.
- Keep the response concise, focused on the next action.

USER CHAT CONTEXT (most recent last):
{{targetRoomContext}}

Your last autonomous note: "{{lastThought}}"

Continue the task. Output <thought> and take action now."#;

pub const AUTONOMY_TASK_FIRST_TEMPLATE: &str = r#"You are running in AUTONOMOUS TASK MODE.

Your job: continue helping the user and make progress toward the task.
- Use available actions/tools to gather information or execute steps.
- If you need UI control, use ComputerUse actions.
- In MCP mode, selector-based actions require a process scope (pass process=... or prefix selector with "process:<name> >> ...").
- Prefer safe, incremental steps; if unsure, gather more UI context before acting.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: ONLY a <thought> plus any actions. No other message text.

USER CHAT CONTEXT (most recent last):
{{targetRoomContext}}

Decide what to do next. Output <thought>, then take the most useful action."#;

pub const CHOOSE_OPTION_TEMPLATE: &str = r#"# Task: Choose an option from the available choices.

{{providers}}

# Available Options:
{{options}}

# Instructions: 
Analyze the options and select the most appropriate one based on the current context.
Provide your reasoning and the selected option ID.

Respond using TOON like this:
thought: Your reasoning for the selection
selected_id: The ID of the selected option

IMPORTANT: Your response must ONLY contain the TOON document above."#;

pub const IMAGE_DESCRIPTION_TEMPLATE: &str = r#"Task: Analyze the provided image and generate a comprehensive description with multiple levels of detail.

Instructions:
Carefully examine the image and provide:
1. A concise, descriptive title that captures the main subject or scene
2. A brief summary description (1-2 sentences) highlighting the key elements
3. An extensive, detailed description that covers all visible elements, composition, lighting, colors, mood, and any other relevant details

Be objective and descriptive. Focus on what you can actually see in the image rather than making assumptions about context or meaning.

Output:

Respond using TOON like this:
title: A concise, descriptive title for the image
description: A brief 1-2 sentence summary of the key elements in the image
text: An extensive, detailed description covering all visible elements, composition, lighting, colors, mood, setting, objects, people, activities, and any other relevant details you can observe in the image

IMPORTANT: Your response must ONLY contain the TOON document above. Do not include any text, thinking, or reasoning before or after it."#;

pub const IMAGE_GENERATION_TEMPLATE: &str = r#"# Task: Generate an image prompt for {{agentName}}.

{{providers}}

# Instructions:
Based on the conversation, create a detailed prompt for image generation.
The prompt should be specific, descriptive, and suitable for AI image generation.

# Recent conversation:
{{recentMessages}}

Respond using TOON like this:
thought: Your reasoning for the image prompt
prompt: Detailed image generation prompt

IMPORTANT: Your response must ONLY contain the TOON document above."#;

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

pub const MESSAGE_HANDLER_TEMPLATE: &str = r#"task: Generate dialog and actions for {{agentName}}.

context:
{{providers}}

rules[9]:
- think briefly, then respond
- always include a <thought> field, even for direct replies
- actions execute in listed order
- if replying, REPLY goes first
- use IGNORE or STOP only by themselves
- include providers only when needed
- use provider_hints from context when present instead of restating the same rules
- if an action needs inputs, include them inside that action's <params> block
- if a required param is unknown, ask for clarification in text

control_actions:
- STOP means the task is done and the agent should end the run without executing more actions
- STOP is a terminal control action even if it is not listed in available actions

fields[5]{name,meaning}:
- thought | short plan
- actions | ordered <action> entries inside <actions>
- providers | array of provider names, or empty
- text | next message for {{agentName}}
- simple | true or false

formatting:
- wrap multi-line code in fenced code blocks
- use inline backticks for short code identifiers

output:
XML only. Return exactly one <response>...</response> document. No prose before or after it. No <think>.

Example:
<response>
  <thought>Reply briefly. No extra providers needed.</thought>
  <actions>
    <action>
      <name>REPLY</name>
    </action>
  </actions>
  <providers></providers>
  <text>Your message here</text>
  <simple>true</simple>
</response>"#;

pub const MULTI_STEP_DECISION_TEMPLATE: &str = r#"Determine the next step the assistant should take in this conversation to help the user reach their goal.

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

keys:
"thought" Clearly explain your reasoning for the selected providers and/or action, and how this step contributes to resolving the user's request.
"action"  Name of the action to execute after providers return (can be empty if no action is needed).
"providers" List of provider names to call in this step (can be empty if none are needed).
"isFinish" Set to true only if the task is fully complete.

⚠️ IMPORTANT: Do **not** mark the task as `isFinish: true` immediately after calling an action. Wait for the action to complete before deciding the task is finished.

output:
thought: Your thought here
action: ACTION
providers[2]: PROVIDER1,PROVIDER2
isFinish: false"#;

pub const MULTI_STEP_SUMMARY_TEMPLATE: &str = r#"Summarize what the assistant has done so far and provide a final response to the user based on the completed steps.

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

 - Your final output MUST be TOON in this format:
output:
thought: Your thought here
text: Your final message to the user"#;

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


Return in TOON format:
taskId: string_or_null
selectedOption: OPTION_NAME_or_null

IMPORTANT: Your response must ONLY contain the TOON document above. Do not include any text, thinking, or reasoning before or after it."#;

pub const POST_ACTION_DECISION_TEMPLATE: &str = r#"Continue helping the user after reviewing the latest action results.

context:
{{providers}}

recent conversation:
{{recentMessages}}

recent action results:
{{actionResults}}

latest reflection task status:
{{taskCompletionStatus}}

rules[10]:
- think briefly, then continue the task from the latest action results
- actions execute in listed order
- if replying, REPLY goes first
- use IGNORE or STOP only by themselves
- include providers only when needed
- use provider_hints from context when present instead of restating the same rules
- if an action needs inputs, include them under params keyed by action name
- if a required param is unknown, ask for clarification in text
- if reflection says the task is incomplete, keep working or explain the concrete follow-up you still need
- if the task is complete, either reply to the user or use STOP to end the run
- STOP is a terminal control action even if it is not listed in available actions

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

thought: Your thought here
actions[1]: ACTION
providers[0]:
text: Your message here
simple: true"#;

pub const POST_CREATION_TEMPLATE: &str = r#"# Task: Create a post in the voice and style and perspective of {{agentName}} @{{xUserName}}.

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

Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 280. No emojis. Use \n\n (double spaces) between statements if there are multiple statements in your response.

Your output should be formatted as TOON like this:
thought: Your thought here
post: Your post text here
imagePrompt: Optional image prompt here

The "post" field should be the post you want to send. Do not including any thinking or internal reflection in the "post" field.
The "imagePrompt" field is optional and should be a prompt for an image that is relevant to the post. It should be a single sentence that captures the essence of the post. ONLY USE THIS FIELD if it makes sense that the post would benefit from an image.
The "thought" field should be a short description of what the agent is thinking about before responding, including a brief justification for the response. Includate an explanation how the post is relevant to the topic but unique and different than other posts.


IMPORTANT: Your response must ONLY contain the TOON document above. Do not include any text, thinking, or reasoning before or after it."#;

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

# Latest Action Results:
{{actionResults}}

# Instructions:
1. Generate a self-reflective thought on the conversation about your performance and interaction quality.
2. Extract only durable new facts from the conversation.
  - Prefer facts about the current user/sender that will still matter in a week: identity, stable preferences, recurring collaborators, durable setup, long-term projects, or ongoing constraints.
  - Do NOT extract temporary status updates, current debugging/work items, one-off session metrics, isolated praise/complaints, or facts that are only true right now.
  - If a fact would feel stale, irrelevant, or surprising to store a week from now, skip it.
  - When in doubt, omit the fact.
3. Identify and describe relationships between entities.
  - The sourceEntityId is the UUID of the entity initiating the interaction.
  - The targetEntityId is the UUID of the entity being interacted with.
  - Relationships are one-direction, so a friendship would be two entity relationships where each entity is both the source and the target of the other.
4. It is normal to return no facts when nothing durable was learned.
5. Always decide whether the user's task or request is actually complete right now.
  - Set `task_completed: true` only if the user no longer needs additional action or follow-up from you in this turn.
  - If you asked a clarifying question, an action failed, work is still pending, or you only partially completed the request, set `task_completed: false`.
6. Always include a short `task_completion_reason` grounded in the conversation and action results.

Output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.
Do not output JSON, XML, Markdown fences, or commentary.
Use indexed TOON fields exactly like this:
thought: "a self-reflective thought on the conversation"
task_completed: false
task_completion_reason: "The request is still incomplete because the needed action has not happened yet."
facts[0]:
  claim: durable factual statement
  type: fact
  in_bio: false
  already_known: false
relationships[0]:
  sourceEntityId: entity_initiating_interaction
  targetEntityId: entity_being_interacted_with
  tags[0]: dm_interaction

For additional entries, increment the index: facts[1], relationships[1], tags[1], etc.
Always include `task_completed` and `task_completion_reason`.
If there are no durable new facts, omit all facts[...] entries.
If there are no relationships, omit all relationships[...] entries.

IMPORTANT: Your response must ONLY contain the TOON document above. Do not include any text, thinking, or reasoning before or after it."#;

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

Respond using TOON like this:
thought: Your detailed analysis
quality_score: Score 0-100 for overall quality
strengths: What went well
improvements: What could be improved
learnings: Key takeaways for future interactions

IMPORTANT: Your response must ONLY contain the TOON document above."#;

pub const REMOVE_CONTACT_TEMPLATE: &str = r#"task: Extract the contact removal request.

context:
{{providers}}

current_message:
{{message}}

instructions[4]:
- identify the contact name to remove
- set confirmed to yes only when the user explicitly confirms removal
- set confirmed to no when confirmation is absent or ambiguous
- return only the requested contact

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
contactName: Jane Doe
confirmed: yes"#;

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
Go directly to the TOON response format without any preamble or explanation.

Respond using TOON like this:
thought: Your thought here
text: Your message here

IMPORTANT: Your response must ONLY contain the TOON document above. Do not include any text, thinking, or reasoning before or after it."#;

pub const SCHEDULE_FOLLOW_UP_TEMPLATE: &str = r#"task: Extract follow-up scheduling information from the request.

context:
{{providers}}

current_message:
{{message}}

current_datetime:
{{currentDateTime}}

instructions[5]:
- identify who to follow up with
- include entityId only when it is explicitly known
- convert requested timing into an ISO datetime in scheduledAt
- normalize priority to high, medium, or low
- include message only when the user asked for a specific note or reminder text

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
contactName: Jane Doe
entityId:
scheduledAt: 2026-04-06T14:00:00.000Z
reason: Check in on the proposal
priority: medium
message: Send the latest deck before the call"#;

pub const SEARCH_CONTACTS_TEMPLATE: &str = r#"task: Extract contact search criteria from the request.

context:
{{providers}}

current_message:
{{message}}

instructions[5]:
- return categories as a comma-separated list when the user filters by category
- return tags as a comma-separated list when the user filters by tags
- return searchTerm for any name or free-text lookup
- set intent to count when the user only wants a count, otherwise list
- omit fields that are not clearly requested

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
categories: vip,colleague
searchTerm: Jane
tags: ai,design
intent: list"#;

pub const SHOULD_FOLLOW_ROOM_TEMPLATE: &str = r#"task: Decide whether {{agentName}} should follow this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user is clearly asking {{agentName}} to follow, join, listen to, or stay engaged in this room
- return false when the request is ambiguous or unrelated
- prefer false when uncertain

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
decision: true"#;

pub const SHOULD_MUTE_ROOM_TEMPLATE: &str = r#"task: Decide whether {{agentName}} should mute this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user is clearly asking {{agentName}} to mute, silence, or ignore this room
- return false when the request is ambiguous or unrelated
- prefer false when uncertain

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
decision: true"#;

pub const SHOULD_RESPOND_TEMPLATE: &str = r#"task: Decide whether {{agentName}} should respond, ignore, or stop.

context:
{{providers}}

rules[6]:
- direct mention of {{agentName}} -> RESPOND
- different assistant name or talking to someone else -> IGNORE unless {{agentName}} is also directly addressed
- prior participation by {{agentName}} in the thread is not enough by itself; the newest message must still clearly expect {{agentName}} -> otherwise IGNORE
- request to stop or be quiet directed at {{agentName}} -> STOP
- if multiple people are mentioned and {{agentName}} is one of the addressees -> RESPOND
- if unsure whether the speaker is talking to {{agentName}}, prefer IGNORE over hallucinating relevance

available_contexts:
{{availableContexts}}

context_routing:
- primaryContext: choose one context from available_contexts, or "general" if none apply
- secondaryContexts: optional comma-separated list of additional relevant contexts
- evidenceTurnIds: optional comma-separated list of message IDs supporting the decision

decision_note:
- respond only when the latest message is talking TO {{agentName}}
- talking TO {{agentName}} means name mention, reply chain, or a clear follow-up that still expects {{agentName}} to answer
- mentions of other people do not cancel a direct address to {{agentName}}
- casual conversation between other users is not enough
- if another assistant already answered and nobody re-addressed {{agentName}}, IGNORE
- if {{agentName}} already replied recently and nobody re-addressed {{agentName}}, IGNORE
- talking ABOUT {{agentName}} or continuing a room conversation around them is not enough

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
name: {{agentName}}
reasoning: Direct mention and clear follow-up.
action: RESPOND
primaryContext: general
secondaryContexts:
evidenceTurnIds:"#;

pub const SHOULD_RESPOND_WITH_CONTEXT_TEMPLATE: &str = r#"task: Decide whether {{agentName}} should respond and which domain context applies.

context:
{{providers}}

available_contexts:
{{availableContexts}}

rules[6]:
- direct mention of {{agentName}} -> RESPOND
- different assistant name or talking to someone else -> IGNORE unless {{agentName}} is also directly addressed
- prior participation by {{agentName}} in the thread is not enough by itself; the newest message must still clearly expect {{agentName}} -> otherwise IGNORE
- request to stop or be quiet directed at {{agentName}} -> STOP
- if multiple people are mentioned and {{agentName}} is one of the addressees -> RESPOND
- if unsure whether the speaker is talking to {{agentName}}, prefer IGNORE over hallucinating relevance

context_routing:
- primaryContext: the single best-matching domain from available_contexts
- secondaryContexts: zero or more additional domains that are relevant
- action intent does not only come from the last message; consider the full recent conversation
- if no specific domain applies, use "general"

decision_note:
- respond only when the latest message is talking TO {{agentName}}
- talking TO {{agentName}} means name mention, reply chain, or a clear follow-up that still expects {{agentName}} to answer
- mentions of other people do not cancel a direct address to {{agentName}}
- casual conversation between other users is not enough
- if another assistant already answered and nobody re-addressed {{agentName}}, IGNORE
- if {{agentName}} already replied recently and nobody re-addressed {{agentName}}, IGNORE
- talking ABOUT {{agentName}} or continuing a room conversation around them is not enough
- context routing always applies, even for IGNORE/STOP decisions

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
name: {{agentName}}
reasoning: Direct mention asking about token balance.
action: RESPOND
primaryContext: wallet
secondaryContexts: []"#;

pub const SHOULD_UNFOLLOW_ROOM_TEMPLATE: &str = r#"task: Decide whether {{agentName}} should unfollow this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user is clearly asking {{agentName}} to stop following or leave this room
- return false when the request is ambiguous or unrelated
- prefer false when uncertain

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
decision: true"#;

pub const SHOULD_UNMUTE_ROOM_TEMPLATE: &str = r#"task: Decide whether {{agentName}} should unmute this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user is clearly asking {{agentName}} to unmute or resume listening to this room
- return false when the request is ambiguous or unrelated
- prefer false when uncertain

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
decision: true"#;

pub const THINK_TEMPLATE: &str = r#"# Task: Think deeply and reason carefully for {{agentName}}.

{{providers}}

# Context
The initial planning phase identified this question as requiring deeper analysis.
The following is the conversation so far and all available context.

# Instructions
You are {{agentName}}. A question or request has been identified as complex, ambiguous, or requiring careful reasoning. Your job is to think through this thoroughly before responding.

Approach this systematically:
1. Identify the core question or problem being asked
2. Consider multiple angles, approaches, or interpretations
3. Evaluate trade-offs, risks, and constraints
4. Draw on relevant knowledge and context from the conversation
5. Arrive at a well-reasoned conclusion or recommendation

Be thorough but concise. Prioritize depth of reasoning over length. If there are genuine unknowns, acknowledge them rather than guessing.

Respond using TOON:
thought: Your detailed internal reasoning — the full chain of thought, alternatives considered, and why you reached your conclusion
text: Your response to the user — clear, structured, and well-reasoned. Use headings, lists, or code blocks as appropriate for the content.

IMPORTANT: Your response must ONLY contain the TOON document above. Do not include any preamble or explanation outside of it."#;

pub const UPDATE_CONTACT_TEMPLATE: &str = r#"task: Extract contact updates from the request.

context:
{{providers}}

current_message:
{{message}}

instructions[6]:
- identify the contact name to update
- set operation to replace unless the user clearly says to add_to or remove_from
- return categories and tags as comma-separated lists
- return preferences and customFields as comma-separated key:value pairs
- include notes only when explicitly requested
- omit fields that are not being changed

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
contactName: Jane Doe
operation: add_to
categories: vip
tags: ai,friend
preferences: timezone:America/New_York,language:English
customFields: company:Acme,title:Designer
notes: Prefers async communication"#;

pub const UPDATE_ENTITY_TEMPLATE: &str = r#"# Task: Update entity information.

{{providers}}

# Current Entity Information:
{{entityInfo}}

# Instructions:
Based on the request, determine what information about the entity should be updated.
Only update fields that the user has explicitly requested to change.

Respond using TOON like this:
thought: Your reasoning for the entity update
entity_id: The entity ID to update
updates[1]{name,value}:
  field_name,new_value

IMPORTANT: Your response must ONLY contain the TOON document above."#;

pub const UPDATE_ROLE_TEMPLATE: &str = r#"task: Extract the requested role change.

context:
{{providers}}

current_roles:
{{roles}}

recent_messages:
{{recentMessages}}

current_message:
{{message}}

instructions[6]:
- identify the single entity whose role should be updated
- return entity_id only when the UUID is explicit in context
- normalize new_role to one of OWNER, ADMIN, MEMBER, GUEST, or NONE
- if the user is removing elevated access without naming a new role, use NONE
- do not invent entity ids or roles
- include a short thought describing the change

output:
TOON only. Return exactly one TOON document. No prose before or after it. No <think>.

Example:
thought: Sarah should become an admin.
entity_id: 00000000-0000-0000-0000-000000000000
new_role: ADMIN"#;

pub const UPDATE_SETTINGS_TEMPLATE: &str = r#"# Task: Update settings based on the request.

{{providers}}

# Current Settings:
{{settings}}

# Instructions:
Based on the request, determine which settings to update.
Only update settings that the user has explicitly requested.

Respond using TOON like this:
thought: Your reasoning for the settings changes
updates[1]{key,value}:
  setting_key,new_value

IMPORTANT: Your response must ONLY contain the TOON document above."#;

pub const BOOLEAN_FOOTER: &str = "Respond with only a YES or a NO.";
