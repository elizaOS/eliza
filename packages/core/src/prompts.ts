/**
 * Auto-generated prompt templates for elizaOS
 * DO NOT EDIT - Generated from packages/prompts/prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const addContactTemplate = `task: Extract contact information to add to the relationships.

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

Example:
contactName: Jane Doe
entityId:
categories: vip,colleague
notes: Met at the design summit
timezone: America/New_York
language: English
reason: Important collaborator to remember

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const ADD_CONTACT_TEMPLATE = addContactTemplate;

export const autonomyContinuousContinueTemplate = `Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- Use thinking to think about and plan what you want to do.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: a JSON object with a thought field plus an optional actions list.
- If you don't need to make a change this round, take no action and output only the thought field with an empty actions value.
- If you cannot act, explain what is missing inside thought and take no action.
- Keep the response concise, focused on the next action.

USER CONTEXT (most recent last):
{{targetRoomContext}}

Your last autonomous note: "{{lastThought}}"

Continue from that note. Output a JSON thought and take action if needed.

Example (no action this round):
thought: Continuing from prior note; nothing new to act on.
actions:

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE = autonomyContinuousContinueTemplate;

export const autonomyContinuousFirstTemplate = `Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- Use thinking to think about and plan what you want to do.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: a JSON object with a thought field plus an optional actions list.
- If you don't need to make a change this round, take no action and output only the thought field with an empty actions value.
- If you cannot act, explain what is missing inside thought and take no action.
- Keep the response concise, focused on the next action.

USER CONTEXT (most recent last):
{{targetRoomContext}}

Think briefly, then output a JSON thought and take action if needed.

Example (no action this round):
thought: Inspecting current state; nothing to act on this round.
actions:

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const AUTONOMY_CONTINUOUS_FIRST_TEMPLATE = autonomyContinuousFirstTemplate;

export const autonomyTaskContinueTemplate = `You are running in AUTONOMOUS TASK MODE.

Your job: continue helping the user and make progress toward the task.
- Use available actions/tools when they can advance the goal.
- Use thinking to think about and plan what you want to do.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: a JSON object with a thought field plus an optional actions list.
- If you don't need to make a change this round, take no action and output only the thought field with an empty actions value.
- If you cannot act, explain what is missing inside thought and take no action.
- Keep the response concise, focused on the next action.

USER CHAT CONTEXT (most recent last):
{{targetRoomContext}}

Your last autonomous note: "{{lastThought}}"

Continue the task. Output a JSON thought and take action now.

Example (no action this round):
thought: Waiting on prior step to complete; nothing to do this round.
actions:

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const AUTONOMY_TASK_CONTINUE_TEMPLATE = autonomyTaskContinueTemplate;

export const autonomyTaskFirstTemplate = `You are running in AUTONOMOUS TASK MODE.

Your job: continue helping the user and make progress toward the task.
- Use available actions/tools when they can advance the goal.
- Use thinking to think about and plan what you want to do.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: a JSON object with a thought field plus an optional actions list.
- If you don't need to make a change this round, take no action and output only the thought field with an empty actions value.
- If you cannot act, explain what is missing inside thought and take no action.
- Keep the response concise, focused on the next action.

USER CHAT CONTEXT (most recent last):
{{targetRoomContext}}

Decide what to do next. Output a JSON thought, then take the most useful action.

Example:
thought: Need to gather UI state before acting.
actions[1]:
  - name: COMPUTER_USE_INSPECT

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const AUTONOMY_TASK_FIRST_TEMPLATE = autonomyTaskFirstTemplate;

export const chooseOptionTemplate = `# Task: Choose an option from the available choices.

{{providers}}

# Available Options:
{{options}}

# Instructions: 
Analyze the options and select the most appropriate one based on the current context.
Provide your reasoning and the selected option ID.

Respond using JSON like this:
thought: Your reasoning for the selection
selected_id: The ID of the selected option

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const CHOOSE_OPTION_TEMPLATE = chooseOptionTemplate;

export const extractSecretOperationTemplate = `You are helping manage secrets for an AI agent.

Determine what operation the user wants to perform:
- get: Retrieve a secret value
- set: Store a new secret
- delete: Remove a secret
- list: Show all available secrets (without values)
- check: Check if a secret exists

Common patterns:
- "What is my OpenAI key?" -> operation: get, key: OPENAI_API_KEY
- "Do I have a Discord token set?" -> operation: check, key: DISCORD_BOT_TOKEN
- "Show me my secrets" -> operation: list
- "Delete my old API key" -> operation: delete
- "Remove TWITTER_API_KEY" -> operation: delete, key: TWITTER_API_KEY
- "Set my key to sk-..." -> operation: set, key: <infer>, value: sk-...

{{recentMessages}}

Extract the operation, key (if applicable), value (if applicable), level, description, and type from the user's message.

Use only these fields:
operation: get|set|delete|list|check
key: OPENAI_API_KEY
value: secret_value
level: global|world|user
description: short_description
type: api_key|secret|credential|url|config

Omit unknown optional fields.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const EXTRACT_SECRET_OPERATION_TEMPLATE = extractSecretOperationTemplate;

export const extractSecretRequestTemplate = `You are helping an AI agent request a missing secret.
Determine what secret the agent needs and why based on the recent conversation.

Common patterns:
- "I need an API key for OpenAI" -> key: OPENAI_API_KEY
- "Missing TWITTER_TOKEN" -> key: TWITTER_TOKEN
- "I cannot proceed without a Discord token" -> key: DISCORD_TOKEN

Recent Messages:
{{recentMessages}}

Use:
key: OPENAI_API_KEY
reason: why it is needed

If no specific secret is requested, leave key empty.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const EXTRACT_SECRET_REQUEST_TEMPLATE = extractSecretRequestTemplate;

export const extractSecretsTemplate = `You are extracting secret/configuration values from the user's message.

The user wants to set one or more secrets. Extract:
1. The secret key (should be UPPERCASE_WITH_UNDERSCORES format)
2. The secret value
3. Optional description
4. Secret type (api_key, secret, credential, url, or config)

Common patterns:
- "Set my OpenAI key to sk-..." -> key: OPENAI_API_KEY, value: sk-...
- "My Anthropic API key is sk-ant-..." -> key: ANTHROPIC_API_KEY, value: sk-ant-...
- "Use this Discord token: ..." -> key: DISCORD_BOT_TOKEN, value: ...
- "Set DATABASE_URL to postgres://..." -> key: DATABASE_URL, value: postgres://...

{{recentMessages}}

Extract the secrets from the user's message. If the key name isn't explicitly specified, infer an appropriate UPPERCASE_WITH_UNDERSCORES name based on the context.

Use:
secrets[n]{key,value,description,type}:
level: global|world|user

Omit description/type/level when unknown.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const EXTRACT_SECRETS_TEMPLATE = extractSecretsTemplate;

export const factExtractionTemplate = `# Task: Classify and extract facts from this message

You maintain two fact stores for an AI assistant. Decide what to insert, strengthen, decay, or contradict. Return JSON ops only.

Stores:
- durable: stable identity-level claims that matter in a year.
  Categories: identity, health, relationship, life_event, business_role, preference, goal.
- current: time-bound state about right now or the near term.
  Categories: feeling, physical_state, working_on, going_through, schedule_context.

Rules:
- If a claim feels stale or surprising to retrieve in a year, use current.
- Empty output is right for small talk or questions with no new claim.
- Before add_durable/add_current, scan known facts. If meaning already exists, emit strengthen with that factId.
- Paraphrases count as duplicates. Match meaning, not surface form.

Ops:
- add_durable: claim, category, structured_fields; optional verification_status, reason.
- add_current: claim, category, structured_fields; optional valid_at, reason.
- strengthen: factId, optional reason.
- decay: factId, optional reason.
- contradict: factId, reason, optional proposedText.

Examples:

Message: "I have a flat cortisol curve confirmed via lab"
{
  "ops": [
    {
      "op": "add_durable",
      "claim": "flat cortisol curve",
      "category": "health",
      "structured_fields": {
        "condition": "flat cortisol curve",
        "source": "lab"
      },
      "verification_status": "confirmed"
    }
  ]
}

Message: "I'm anxious this morning"
{
  "ops": [
    {
      "op": "add_current",
      "claim": "anxious this morning",
      "category": "feeling",
      "structured_fields": {
        "emotion": "anxious",
        "window": "morning"
      }
    }
  ]
}

Known durable facts include: [fact_abc] (durable.identity) lives in Berlin
Message: "Berlin's been treating me well"
{
  "ops": [
    {
      "op": "strengthen",
      "factId": "fact_abc",
      "reason": "user reaffirmed living in Berlin"
    }
  ]
}

Known durable facts include: [fact_abc] (durable.identity) lives in Berlin
Message: "Actually I moved to Tokyo last month"
{
  "ops": [
    {
      "op": "contradict",
      "factId": "fact_abc",
      "proposedText": "lives in Tokyo",
      "reason": "user moved to Tokyo, contradicts Berlin"
    },
    {
      "op": "add_durable",
      "claim": "moved to Tokyo last month",
      "category": "life_event",
      "structured_fields": {
        "event": "relocation",
        "to": "Tokyo"
      }
    }
  ]
}

Inputs:
Agent Name: {{agentName}}
Message Sender: {{senderName}} (ID: {{senderId}})
Now: {{now}}

Recent messages:
{{recentMessages}}

Known durable facts (format: [factId] (durable.category) claim):
{{knownDurable}}

Known current facts (format: [factId] (current.category, since validAt) claim):
{{knownCurrent}}

Latest message:
{{message}}

Output:
If nothing should change, return:
{"ops":[]}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const FACT_EXTRACTION_TEMPLATE = factExtractionTemplate;

export const imageDescriptionTemplate = `Task: Analyze the provided image and generate a comprehensive description with multiple levels of detail.

Instructions:
Carefully examine the image and provide:
1. A concise, descriptive title that captures the main subject or scene
2. A brief summary description (1-2 sentences) highlighting the key elements
3. An extensive, detailed description that covers all visible elements, composition, lighting, colors, mood, and any other relevant details

Be objective and descriptive. Focus on what you can actually see in the image rather than making assumptions about context or meaning.

Output:

Respond using JSON like this:
title: A concise, descriptive title for the image
description: A brief 1-2 sentence summary of the key elements in the image
text: An extensive, detailed description covering all visible elements, composition, lighting, colors, mood, setting, objects, people, activities, and any other relevant details you can observe in the image

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const IMAGE_DESCRIPTION_TEMPLATE = imageDescriptionTemplate;

export const imageGenerationTemplate = `# Task: Generate an image prompt for {{agentName}}.

{{providers}}

# Instructions:
Based on the conversation, create a detailed prompt for image generation.
The prompt should be specific, descriptive, and suitable for AI image generation.

# Recent conversation:
{{recentMessages}}

Respond using JSON like this:
thought: Your reasoning for the image prompt
prompt: Detailed image generation prompt

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const IMAGE_GENERATION_TEMPLATE = imageGenerationTemplate;

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

Respond in JSON:
text: Your comprehensive summary here
topics[0]: topic1
topics[1]: topic2
topics[2]: topic3
keyPoints[0]: First key point
keyPoints[1]: Second key point

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const INITIAL_SUMMARIZATION_TEMPLATE = initialSummarizationTemplate;

export const longTermExtractionTemplate = `# Task: Extract Long-Term Memory (Strict Criteria)

Analyze the conversation and extract ONLY the most critical, persistent information about the user.

# Recent Messages
{{recentMessages}}

# Current Long-Term Memories
{{existingMemories}}

# Memory Categories

Categories: episodic (events tied to a specific time/place), semantic (general knowledge), procedural (how-to).

**Episodic examples:**
- "User completed migration project from MongoDB to PostgreSQL in Q2 2024"
- "User encountered authentication bug in production on March 15th"

**Semantic examples:**
- "User is a senior backend engineer with 8 years experience"
- "User specializes in distributed systems and microservices architecture"

**Procedural examples:**
- "User follows strict TDD workflow: write tests first, then implementation"
- "User prefers git rebase over merge to maintain linear history"

# Extraction Criteria

## DO EXTRACT (Only These):

**EPISODIC:**
- Significant completed projects or milestones
- Important bugs, incidents, or problems encountered
- Major decisions made with lasting impact
- Formative experiences that shape future work

**SEMANTIC:**
- Professional identity (role, title, company)
- Core expertise and specializations (stated explicitly or demonstrated conclusively)
- Primary languages, frameworks, or tools (not exploratory use)
- Established facts about their work context

**PROCEDURAL:**
- Consistent workflows demonstrated 3+ times or explicitly stated
- Standard practices user always follows
- Methodology preferences with clear rationale

## NEVER EXTRACT:

Skip ephemeral state, one-time requests, social pleasantries, and exploratory Q&A.
This includes temporary context, single-occurrence preferences, generic patterns, and opinions without persistence.

# Quality Gates (ALL Must Pass)

1. **Significance Test**: Will this matter in 3+ months?
2. **Specificity Test**: Is this concrete and actionable?
3. **Evidence Test**: Is there strong evidence (3+ instances OR explicit self-identification)?
4. **Uniqueness Test**: Is this specific to THIS user (not generic)?
5. **Confidence Test**: Confidence must be >= 0.85.
6. **Non-Redundancy Test**: Does this add NEW information not in existing memories?

# Confidence Scoring

- **0.95-1.0**: User explicitly stated as core identity/practice AND demonstrated multiple times
- **0.85-0.94**: User explicitly stated OR consistently demonstrated 5+ times
- **0.75-0.84**: Strong pattern (3-4 instances) with supporting context
- **Below 0.75**: DO NOT EXTRACT (insufficient evidence)

Default to NOT extracting. Maximum 2-3 extractions per run. If there are no qualifying facts (which is common), return no memories entries.

# Response Format

memories[0]:
  category: semantic
  content: User is a senior TypeScript developer with 8 years of backend experience
  confidence: 0.95
memories[1]:
  category: procedural
  content: User follows TDD workflow: writes tests before implementation, runs tests after each change
  confidence: 0.88
memories[2]:
  category: episodic
  content: User led database migration from MongoDB to PostgreSQL for payment system in Q2 2024
  confidence: 0.92

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const LONG_TERM_EXTRACTION_TEMPLATE = longTermExtractionTemplate;

export const messageHandlerTemplate = `task: Decide whether {{agentName}} should respond and which contexts are needed.

context:
{{providers}}

rules:
- choose action=RESPOND only when {{agentName}} should answer or perform work for this message
- choose action=IGNORE when the message should be ignored
- choose action=STOP when the user asks {{agentName}} to stop or disengage
- contexts is a list of registered context ids, such as calendar, email, wallet, browser, code, or automation
- never invent context ids that are not registered
- only choose contexts when tools or context providers may be needed
- simple=true only means reply can be sent directly when contexts is empty
- if contexts is non-empty, planning will run and simple will be ignored
- include reply only for a direct user-visible response
- thought is internal routing rationale and is not shown to the user

fields:
- action: RESPOND, IGNORE, or STOP
- simple: boolean
- contexts: array of context ids
- thought: short routing rationale
- reply: optional direct response for simple turns with no contexts

output:
Example:
{
  "action": "RESPOND",
  "simple": true,
  "contexts": [],
  "thought": "The user asked a direct conversational question that needs no tools.",
  "reply": "Your message here"
}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const MESSAGE_HANDLER_TEMPLATE = messageHandlerTemplate;

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

Return in JSON format:
taskId: string_or_null
selectedOption: OPTION_NAME_or_null

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const OPTION_EXTRACTION_TEMPLATE = optionExtractionTemplate;

export const plannerTemplate = `task: Plan the next native tool calls for the current ContextObject.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}

rules:
- use only tools exposed in the current context object
- plan the smallest grounded queue of useful tool calls
- include arguments only when grounded in the user request or prior tool results
- if the task is complete or the only next step is speaking to the user, return no toolCalls and set messageToUser
- do not invent tool names, connector names, providers, ids, or benchmark ids

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const PLANNER_TEMPLATE = plannerTemplate;

export const postCreationTemplate = `# Task: Create a post in the voice and style and perspective of {{agentName}} @{{xUserName}}.

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
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 280. No emojis. Use \\n\\n (double spaces) between statements if there are multiple statements in your response.

Your output should be formatted as JSON like this:
thought: Your thought here
post: Your post text here
imagePrompt: Optional image prompt here

The "post" field should be the post you want to send. Do not including any thinking or internal reflection in the "post" field.
The "imagePrompt" field is optional and should be a prompt for an image that is relevant to the post. It should be a single sentence that captures the essence of the post. ONLY USE THIS FIELD if it makes sense that the post would benefit from an image.
The "thought" field should be a short description of what the agent is thinking about before responding, including a brief justification for the response. Includate an explanation how the post is relevant to the topic but unique and different than other posts.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const POST_CREATION_TEMPLATE = postCreationTemplate;

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
  - Set \`task_completed: true\` only if the user no longer needs additional action or follow-up from you in this turn.
  - If you asked a clarifying question, an action failed, work is still pending, or you only partially completed the request, set \`task_completed: false\`.
6. Always include a short \`task_completion_reason\` grounded in the conversation and action results.

Output:
Use JSON fields exactly like this:
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
Always include \`task_completed\` and \`task_completion_reason\`.
If there are no durable new facts, omit all facts[...] entries.
If there are no relationships, omit all relationships[...] entries.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const REFLECTION_EVALUATOR_TEMPLATE = reflectionEvaluatorTemplate;

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

Respond using JSON like this:
thought: Your detailed analysis
quality_score: Score 0-100 for overall quality
strengths: What went well
improvements: What could be improved
learnings: Key takeaways for future interactions

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const REFLECTION_TEMPLATE = reflectionTemplate;

export const removeContactTemplate = `task: Extract the contact removal request.

context:
{{providers}}

current_message:
{{message}}

instructions[4]:
- identify the contact name to remove
- set confirmed to yes only when the user explicitly confirms removal
- set confirmed to no when confirmation is absent or ambiguous
- return only the requested contact

Example:
contactName: Jane Doe
confirmed: yes

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const REMOVE_CONTACT_TEMPLATE = removeContactTemplate;

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
Go directly to the JSON response format without any preamble or explanation.

Respond using JSON like this:
thought: Your thought here
text: Your message here

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const REPLY_TEMPLATE = replyTemplate;

export const scheduleFollowUpTemplate = `task: Extract follow-up scheduling information from the request.

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

Example:
contactName: Jane Doe
entityId:
scheduledAt: 2026-04-06T14:00:00.000Z
reason: Check in on the proposal
priority: medium
message: Send the latest deck before the call

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const SCHEDULE_FOLLOW_UP_TEMPLATE = scheduleFollowUpTemplate;

export const searchContactsTemplate = `task: Extract contact search criteria from the request.

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

Example:
categories: vip,colleague
searchTerm: Jane
tags: ai,design
intent: list

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const SEARCH_CONTACTS_TEMPLATE = searchContactsTemplate;

export const shouldFollowRoomTemplate = `task: Decide whether {{agentName}} should follow this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user clearly asks {{agentName}} to follow this room
- return false when the request is ambiguous or unrelated
- default to false when uncertain

Example:
decision: true`;

export const SHOULD_FOLLOW_ROOM_TEMPLATE = shouldFollowRoomTemplate;

export const shouldMuteRoomTemplate = `task: Decide whether {{agentName}} should mute this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user clearly asks {{agentName}} to mute this room
- return false when the request is ambiguous or unrelated
- default to false when uncertain

Example:
decision: true`;

export const SHOULD_MUTE_ROOM_TEMPLATE = shouldMuteRoomTemplate;

export const shouldRespondTemplate = `task: Decide whether {{agentName}} should respond, ignore, or stop.

context:
{{providers}}

rules[7]:
- direct mention of {{agentName}} -> RESPOND
- different assistant name or talking to someone else -> IGNORE unless {{agentName}} is also directly addressed
- prior participation by {{agentName}} in the thread is not enough by itself; the newest message must still clearly expect {{agentName}} -> otherwise IGNORE
- request to stop or be quiet directed at {{agentName}} -> STOP
- if multiple people are mentioned and {{agentName}} is one of the addressees -> RESPOND
- in group conversations, if the latest message is addressed to someone else and not to {{agentName}}, IGNORE
- when uncertain whether the speaker is talking to {{agentName}}, default to IGNORE

available_contexts:
{{availableContexts}}

context_routing:
- contexts: list zero or more context ids from available_contexts
- use [] when no tool or context provider is needed
- if contexts is non-empty, planning will run and simple will be ignored

Example JSON output:
{
  "action": "RESPOND",
  "simple": true,
  "contexts": [],
  "thought": "Direct mention and clear follow-up.",
  "reply": "Short direct reply when no context is needed."
}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const SHOULD_RESPOND_TEMPLATE = shouldRespondTemplate;

export const shouldRespondWithContextTemplate = `task: Decide whether {{agentName}} should respond, ignore, or stop.

context:
{{providers}}

rules[7]:
- direct mention of {{agentName}} -> RESPOND
- different assistant name or talking to someone else -> IGNORE unless {{agentName}} is also directly addressed
- prior participation by {{agentName}} in the thread is not enough by itself; the newest message must still clearly expect {{agentName}} -> otherwise IGNORE
- request to stop or be quiet directed at {{agentName}} -> STOP
- if multiple people are mentioned and {{agentName}} is one of the addressees -> RESPOND
- in group conversations, if the latest message is addressed to someone else and not to {{agentName}}, IGNORE
- when uncertain whether the speaker is talking to {{agentName}}, default to IGNORE

available_contexts:
{{availableContexts}}

context_routing:
- contexts: list zero or more context ids from available_contexts
- use [] when no tool or context provider is needed
- if contexts is non-empty, planning will run and simple will be ignored

Example JSON output:
{
  "action": "RESPOND",
  "simple": true,
  "contexts": [],
  "thought": "Direct mention and clear follow-up.",
  "reply": "Short direct reply when no context is needed."
}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const SHOULD_RESPOND_WITH_CONTEXT_TEMPLATE = shouldRespondWithContextTemplate;

export const shouldUnfollowRoomTemplate = `task: Decide whether {{agentName}} should unfollow this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user clearly asks {{agentName}} to unfollow this room
- return false when the request is ambiguous or unrelated
- default to false when uncertain

Example:
decision: true`;

export const SHOULD_UNFOLLOW_ROOM_TEMPLATE = shouldUnfollowRoomTemplate;

export const shouldUnmuteRoomTemplate = `task: Decide whether {{agentName}} should unmute this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user clearly asks {{agentName}} to unmute this room
- return false when the request is ambiguous or unrelated
- default to false when uncertain

Example:
decision: true`;

export const SHOULD_UNMUTE_ROOM_TEMPLATE = shouldUnmuteRoomTemplate;

export const updateContactTemplate = `task: Extract contact updates from the request.

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

Example:
contactName: Jane Doe
operation: add_to
categories: vip
tags: ai,friend
preferences: timezone:America/New_York,language:English
customFields: company:Acme,title:Designer
notes: Prefers async communication

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const UPDATE_CONTACT_TEMPLATE = updateContactTemplate;

export const updateEntityTemplate = `# Task: Update entity information.

{{providers}}

# Current Entity Information:
{{entityInfo}}

# Instructions:
Based on the request, determine what information about the entity should be updated.
Only update fields that the user has explicitly requested to change.

Example output:
thought: User asked to change Sarah's email address.
entity_id: 9b1d6a40-7c0e-4f6c-8f8b-1234abcd5678
updates[1]{name,value}:
  email,sarah@acme.com

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const UPDATE_ENTITY_TEMPLATE = updateEntityTemplate;

export const updateRoleTemplate = `task: Extract the requested role change.

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

Example:
thought: Sarah should become an admin.
entity_id: 00000000-0000-0000-0000-000000000000
new_role: ADMIN

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const UPDATE_ROLE_TEMPLATE = updateRoleTemplate;

export const updateSettingsTemplate = `# Task: Update settings based on the request.

{{providers}}

# Current Settings:
{{settings}}

# Instructions:
Based on the request, determine which settings to update.
Only update settings that the user has explicitly requested.

Example output:
thought: User asked to switch the default model to gpt-5.5.
updates[1]{key,value}:
  default_model,gpt-5.5

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const UPDATE_SETTINGS_TEMPLATE = updateSettingsTemplate;

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

Respond in JSON:
text: Your updated and condensed summary here
topics[0]: topic1
topics[1]: topic2
topics[2]: topic3
keyPoints[0]: First key point
keyPoints[1]: Second key point

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const UPDATE_SUMMARIZATION_TEMPLATE = updateSummarizationTemplate;

export const booleanFooter = "Respond with only a YES or a NO.";

export const BOOLEAN_FOOTER = booleanFooter;
