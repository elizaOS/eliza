/**
 * Auto-generated prompt templates for elizaOS
 * DO NOT EDIT - Generated from packages/prompts/prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const addContactTemplate = `task: Extract contact information to add to relationships.

context:
{{providers}}

recent_messages:
{{recentMessages}}

current_message:
{{message}}

instructions[5]:
- identify the contact name being added
- include entityId only when explicitly known from context
- return categories as comma-separated list
- include notes, timezone, language only when clearly present
- include short reason for saving this contact

output:
JSON only. One JSON object. No prose, no <think>.

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

export const chooseOptionTemplate = `# Task: Choose an option from available choices.

{{providers}}

# Available Options:
{{options}}

# Instructions:
Select the most appropriate option based on context. Provide reasoning and selected option ID.

JSON:
thought: Your reasoning for the selection
selected_id: The ID of the selected option

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const CHOOSE_OPTION_TEMPLATE = chooseOptionTemplate;

export const customActionGenerateTemplate = `You generate custom action definitions from natural language descriptions.
Given the user's description, return a JSON object with these fields:

- name: string (UPPER_SNAKE_CASE action name)
- description: string (clear description of what the action does)
- similes: optional string[] of alternative action names and phrases
- handlerType: "http" | "shell" | "code"
- handler: object with type-specific fields:
  http  -> { type: "http", method: "GET"|"POST"|etc, url: string, headers?: object, bodyTemplate?: string }
  shell -> { type: "shell", command: string }
  code  -> { type: "code", code: string }
- parameters: array of { name: string, description: string, required: boolean }

Use double-brace placeholders such as \\{{paramName}} in URLs, body templates, and shell commands.
For code handlers, parameters are available via params.paramName and fetch() is available.

User request: {{request}}

Respond with the JSON object only.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const CUSTOM_ACTION_GENERATE_TEMPLATE = customActionGenerateTemplate;

export const defaultCharacterSystemTemplate = `You are {{name}}, an autonomous AI agent powered by elizaOS.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const DEFAULT_CHARACTER_SYSTEM_TEMPLATE = defaultCharacterSystemTemplate;

export const extractActionParamsTemplate = `You are filling in missing parameters for the {{actionName}} action.
Action description: {{actionDescription}}

Parameter schema:
{{schemaLines}}

Already-supplied parameters: {{existingJson}}

Missing required fields you must extract: {{missingFields}}

{{recentConversationBlock}}

Current user message: {{currentMessageText}}

Return a JSON object containing values for the MISSING fields.
If a value is genuinely indeterminable from the conversation, return null for that field.
Example: {"subaction": "search", "query": "github"}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const EXTRACT_ACTION_PARAMS_TEMPLATE = extractActionParamsTemplate;

export const extractSecretOperationTemplate = `Manage secrets for an AI agent.

Determine the operation:
- get: Retrieve a secret value
- set: Store a new secret
- delete: Remove a secret
- list: Show all secrets (without values)
- check: Check if a secret exists

Common patterns:
- "What is my OpenAI key?" -> operation: get, key: OPENAI_API_KEY
- "Do I have a Discord token set?" -> operation: check, key: DISCORD_BOT_TOKEN
- "Show me my secrets" -> operation: list
- "Delete my old API key" -> operation: delete
- "Remove TWITTER_API_KEY" -> operation: delete, key: TWITTER_API_KEY
- "Set my key to sk-..." -> operation: set, key: <infer>, value: sk-...

{{recentMessages}}

Extract operation, key (if applicable), value (if applicable), level, description, and type.

Output JSON only. One JSON object, no prose or fences.
Use only these fields:
operation: get|set|delete|list|check
key: OPENAI_API_KEY
value: secret_value
level: global|world|user
description: short_description
type: api_key|secret|credential|url|config

Omit unknown optional fields. No XML or JSON.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const EXTRACT_SECRET_OPERATION_TEMPLATE = extractSecretOperationTemplate;

export const extractSecretRequestTemplate = `An AI agent is requesting a missing secret.
Determine which secret and why from recent conversation.

Common patterns:
- "I need an API key for OpenAI" -> key: OPENAI_API_KEY
- "Missing TWITTER_TOKEN" -> key: TWITTER_TOKEN
- "I cannot proceed without a Discord token" -> key: DISCORD_TOKEN

Recent Messages:
{{recentMessages}}

Output JSON only. One JSON object, no prose or fences.
Use:
key: OPENAI_API_KEY
reason: why it is needed

If no specific secret requested, leave key empty. No XML or JSON.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const EXTRACT_SECRET_REQUEST_TEMPLATE = extractSecretRequestTemplate;

export const extractSecretsTemplate = `Extract secret/configuration values from user's message.

User wants to set one or more secrets. Extract:
1. Secret key (UPPERCASE_WITH_UNDERSCORES)
2. Secret value
3. Optional description
4. Type (api_key, secret, credential, url, or config)

Common patterns:
- "Set my OpenAI key to sk-..." -> key: OPENAI_API_KEY, value: sk-...
- "My Anthropic API key is sk-ant-..." -> key: ANTHROPIC_API_KEY, value: sk-ant-...
- "Use this Discord token: ..." -> key: DISCORD_BOT_TOKEN, value: ...
- "Set DATABASE_URL to postgres://..." -> key: DATABASE_URL, value: postgres://...

{{recentMessages}}

Extract the secrets. If key name not specified, infer an UPPERCASE_WITH_UNDERSCORES name from context.

Output JSON only. One JSON object, no prose or fences.
Use:
secrets[n]{key,value,description,type}:
level: global|world|user

Omit description/type/level when unknown. No XML or JSON.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const EXTRACT_SECRETS_TEMPLATE = extractSecretsTemplate;

export const factExtractionTemplate = `# Task: Classify and extract facts from this message

You maintain two fact stores. Decide what to insert, strengthen, decay, or contradict. Return JSON ops only.

Stores:
- durable: stable identity-level claims that matter in a year.
  Categories: identity, health, relationship, life_event, business_role, preference, goal.
- current: time-bound state about now or near term.
  Categories: feeling, physical_state, working_on, going_through, schedule_context.

Rules:
- If a claim feels stale or surprising to retrieve in a year, use current.
- Empty output is right for small talk or claim-free questions.
- Before add_durable/add_current, scan known facts. If meaning exists, emit strengthen with that factId.
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
JSON only. One JSON object. No prose, fences, XML, or <think>.
If nothing should change, return:
{"ops":[]}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const FACT_EXTRACTION_TEMPLATE = factExtractionTemplate;

export const imageDescriptionTemplate = `Task: Analyze image and generate description with multiple detail levels.

Provide:
1. Concise descriptive title capturing main subject/scene
2. Brief summary (1-2 sentences) of key elements
3. Extensive description: visible elements, composition, lighting, colors, mood, etc.

Be objective. Describe what you see; don't assume context or meaning.

JSON:
title: A concise, descriptive title for the image
description: A brief 1-2 sentence summary of the key elements in the image
text: An extensive, detailed description covering all visible elements, composition, lighting, colors, mood, setting, objects, people, activities, and any other relevant details you can observe in the image

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const IMAGE_DESCRIPTION_TEMPLATE = imageDescriptionTemplate;

export const imageGenerationTemplate = `# Task: Generate image prompt for {{agentName}}.

{{providers}}

# Instructions:
Create a specific, descriptive image-generation prompt based on the conversation.

# Recent conversation:
{{recentMessages}}

JSON:
thought: Your reasoning for the image prompt
prompt: Detailed image generation prompt

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const IMAGE_GENERATION_TEMPLATE = imageGenerationTemplate;

export const initialSummarizationTemplate = `# Task: Summarize Conversation

Create a concise summary capturing key points, topics, and details.

# Recent Messages
{{recentMessages}}

# Instructions
Generate a summary that:
1. Captures main topics
2. Highlights key information
3. Notes decisions and questions
4. Maintains context for future reference
5. Concise but comprehensive

**Keep summary under 2500 tokens.**

Also extract:
- **Topics**: main topics (comma-separated)
- **Key Points**: important facts or decisions (bullets)

JSON:
text: Your comprehensive summary here
topics[0]: topic1
topics[1]: topic2
topics[2]: topic3
keyPoints[0]: First key point
keyPoints[1]: Second key point

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const INITIAL_SUMMARIZATION_TEMPLATE = initialSummarizationTemplate;

export const longTermExtractionTemplate = `# Task: Extract Long-Term Memory (Strict)

Extract ONLY critical, persistent user info using cognitive memory categories.

# Recent Messages
{{recentMessages}}

# Current Long-Term Memories
{{existingMemories}}

# Memory Categories

## 1. EPISODIC
Specific events with temporal/spatial context.
**Examples:**
- "User completed migration project from MongoDB to PostgreSQL in Q2 2024"
- "User encountered authentication bug in production on March 15th"
- "User had a negative experience with Docker networking in previous job"

**Requirements:**
- WHO did WHAT, WHEN/WHERE
- Specific concrete event (not pattern)
- Significant impact on future work

## 2. SEMANTIC
Stable facts and identity about the user.
**Examples:**
- "User is a senior backend engineer with 8 years experience"
- "User specializes in distributed systems and microservices architecture"
- "User's primary programming language is TypeScript"
- "User works at Acme Corp as technical lead"

**Requirements:**
- Factual, timeless
- Explicitly stated or conclusively demonstrated
- No speculation from single instances
- Core identity, expertise, knowledge only

## 3. PROCEDURAL
Skills, workflows, methodologies, how-to.
**Examples:**
- "User follows strict TDD workflow: write tests first, then implementation"
- "User prefers git rebase over merge to maintain linear history"
- "User's debugging process: check logs → reproduce locally → binary search"
- "User always writes JSDoc comments before implementing functions"

**Requirements:**
- HOW user does something
- Repeated pattern (3+ times) or stated as standard practice
- Workflow, methodology, or skill
- Not one-off preferences

# ULTRA-STRICT CRITERIA

## DO EXTRACT:

**EPISODIC:**
- Significant completed projects/milestones
- Important bugs, incidents, problems
- Major decisions with lasting impact
- Formative experiences shaping future work

**SEMANTIC:**
- Professional identity (role, title, company)
- Core expertise (explicit or conclusively demonstrated)
- Primary languages, frameworks, tools (not exploratory)
- Established work-context facts

**PROCEDURAL:**
- Workflows demonstrated 3+ times or stated
- Standard practices user always follows
- Methodology preferences with rationale
- Debugging, testing, dev processes

## NEVER EXTRACT:

- One-time requests/tasks
- Casual conversations
- Exploratory questions
- Temporary context (current bug, today's task)
- Single-occurrence preferences
- Social pleasantries
- Testing/experimentation
- Common patterns everyone has
- Situational info (working on feature X today)
- Single-instance opinions
- General knowledge (not user-specific)

# Quality Gates (ALL Must Pass)

1. **Significance**: Matters in 3+ months?
2. **Specificity**: Concrete and actionable?
3. **Evidence**: 3+ instances OR explicit self-identification?
4. **Uniqueness**: Specific to THIS user?
5. **Confidence**: >= 0.85
6. **Non-Redundancy**: New info not in existing memories?

# Confidence Scoring

- **0.95-1.0**: Explicitly stated AND demonstrated multiple times
- **0.85-0.94**: Explicitly stated OR consistently demonstrated 5+ times
- **0.75-0.84**: Strong pattern (3-4 instances) with context
- **Below 0.75**: DO NOT EXTRACT

# Critical Rules

1. Default to NOT extracting
2. Require overwhelming evidence
3. Focus on PERSISTENT facts
4. Verify against existing memories
5. Max 2-3 extractions per run

If no qualifying facts (common), return no memories entries.

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

export const memoryContextQaTemplate = `You are a concise context assistant.
Answer only from the provided context. If context is insufficient, say so explicitly.
Keep the answer under 120 words.

Query: {{query}}

Saved memory notes:
{{memorySection}}

Knowledge snippets:
{{knowledgeSection}}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const MEMORY_CONTEXT_QA_TEMPLATE = memoryContextQaTemplate;

export const messageHandlerTemplate = `task: {{#if directMessage}}Decide the plan for this direct message{{else}}Decide processMessage and the plan for this message{{/if}}.

available_contexts:
{{availableContexts}}

{{#if directMessage}}- this is a direct message; processMessage is hardcoded to RESPOND
- do not include processMessage; only choose plan and thought
{{else}}processMessage:
- RESPOND: agent should answer or do work
- IGNORE: skip this message
- STOP: user asked agent to disengage
{{/if}}
plan.contexts: list of ids drawn from available_contexts (calendar, email, ...). Never invent ids.

plan.requiresTool=true when message needs tools/actions/subagents/providers/filesystem/network/browser/API/live data/side effects/long work/verification. Otherwise false.

simple shortcut — choose plan.contexts=["simple"] only when ALL hold:
- purely conversational, greeting, or factual question answerable from training
- no external data, state, person, document, file, schedule, calendar, email, memory, or provider mentioned or implied
- no action verbs (search/find/get/fetch/save/send/create/update/delete/run/execute/call)
- answer would not change if checked against up-to-date info, world state, or memory
- when uncertain: prefer planning over simple

A platform mention, reply target, channel, room, or connector context alone does NOT disqualify simple — use simple when only a direct conversational reply is needed.

Never choose simple when the message:
- needs any tool/action/subagent/provider/filesystem/network/API/live data/side effect/verification
- names a person, place, file, document, data source, or asks about schedules or past interactions ("what did I say earlier", "what's on my calendar", "how many X")
- searches, browses, looks up current facts; runs shell commands; inspects files/logs/repos/services/disk; builds or deploys apps; creates PRs; spawns coding/task agents; sends messages; schedules tasks
- would benefit from a tool call even if the agent could fabricate a plausible answer
- is owner life-management (todos/habits/routines/goals/reminders/alarms/check-ins/blocks/calls/travel/device delivery/desktop actions/approvals) — route to the owning context so its action can ask any missing detail
- changes/persists/updates/remembers agent or user settings, preferences, identity, persona, response style, or future behavior — select settings (and any relevant context)

Domain routing (when context is available):
- morning/night/daily check-ins -> tasks; only include automation if user asks to schedule/change cadence
- relationship cadence ("follow up with David", "last talked to Alice", "how long since I spoke with Sam") -> contacts; one-off dated todos to call/text -> tasks
- explicit phone/call/dial a third party -> phone + contacts; do NOT include calendar just because the call is about an appointment
- device-targeted or broadcast reminders ("to my phone", "all devices", "broadcast") -> automation + connectors (not simple chat); tasks may be secondary
- owner password/saved-login lookup ("look up my GitHub password") -> settings + secrets so PASSWORD_MANAGER handles it; never answer with the raw secret in Stage 1
- website/social-site focus blocking -> automation + settings; app blocking -> automation + settings (not screen_time unless reporting)
- real flight/hotel/trip booking -> browser + calendar + payments + tasks so BOOK_TRAVEL owns the workflow
- Calendly availability + single-use booking links -> calendar + connectors, even when the message contains a Calendly API URL
- health/wearable reads (steps/sleep/heart rate/workouts) -> health
- X/Twitter DMs -> messaging + connectors; X/Twitter timeline/feed/mentions/post search -> social_posting + connectors (not generic web browsing)
- desktop/native-app/browser/Finder/window screenshots or control -> browser or automation (not media alone)
- LifeOps browser bridge/companion/extension/tab/settings -> browser; settings/connectors as secondary when configuration/connection state is asked

Otherwise: list every relevant context id; planning will run and tools will be selected from those contexts. If only general is available and a tool is still needed, use plan.contexts=["general"]. Include plan.reply only on the simple path.

Optional plan fields:
- plan.candidateActions: up to 12 action-like retrieval hints inferred from the request ("send_email", "calendar_create_event", "search_documents", "play_music"). Speculative BM25/regex hints, not tool calls.
- plan.parentActionHints: up to 6 parent action names only when explicit or highly likely. Omit over guess.
- plan.contextSlices: up to 12 stable retrieval slice ids visible in the provided context. Never invent slice ids.

thought is internal rationale, not shown to user.

extract is OPTIONAL. Populate ONLY when the user states a durable fact about themselves, a person they know, or a relationship.
- worth extracting: "my birthday is March 5", "Alice is my manager", "I live in Brooklyn"
- skip: questions, requests, ephemeral state, agent self-talk, anything obvious from agent persona
- extract.facts: short factual statements in the user's voice ("the user's birthday is 1990-03-05"), under ~120 chars each, self-contained
- extract.relationships: subject-predicate-object triples; short entity names ("user", "Alice", "Acme Corp"); snake_case predicate ("works_with", "lives_in", "manages")
- extract.addressedTo: OPTIONAL entity UUIDs (preferred) or participant names this message is directed at. Agent's id/name when user talks to the agent; another participant's id/name when addressed by name or @-mention. Empty/omit when broadcast or unclear. Do not guess.
- omit extract entirely when nothing durable was stated and no addressee identified. Never invent.

Call {{handleResponseToolName}} exactly once with the plan. Do not answer in plain text.

return:
Use the {{handleResponseToolName}} tool. Do not return JSON as message text.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const MESSAGE_HANDLER_TEMPLATE = messageHandlerTemplate;

export const mobileDirectReplyTemplate = `{{system}}

Answer the user directly. Do not select actions, do not return structured control output, and do not explain internal reasoning.
If the user asks for exact words, output exactly those words and nothing else.

User: {{userText}}
{{agentName}}:

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const MOBILE_DIRECT_REPLY_TEMPLATE = mobileDirectReplyTemplate;

export const observationExtractionTemplate = `You are analyzing recent conversation exchanges between a user and an AI assistant.
Extract any durable observations about the user that would be useful across future sessions.

Categories to look for:
- Preferences (tools, languages, workflows, communication style)
- Facts (role, location, projects they work on, tech stack)
- Standing instructions (things they always/never want)
- Patterns (recurring topics, how they like to work)

Return a JSON array of short observation strings (max 150 chars each).
If nothing meaningful is found, return an empty array [].
Do NOT include observations about the conversation itself, only about the user.

Recent exchanges:
{{exchanges}}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const OBSERVATION_EXTRACTION_TEMPLATE = observationExtractionTemplate;

export const optionExtractionTemplate = `# Task: Extract selected task and option from user message

# Available Tasks:
{{tasks}}

# Recent Messages:
{{recentMessages}}

# Instructions:
1. Identify which task and option the user is selecting
2. Match against available tasks and options, including ABORT
3. Return task ID (shortened UUID) and option name exactly as listed
4. If no clear selection, return null for both

JSON:
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
- plan smallest grounded queue of useful tool calls
- include arguments only when grounded in user request or prior tool results
- if task is complete or only next step is speaking to user, return no toolCalls and set messageToUser
- do not invent tool names, connector names, providers, ids, or benchmark ids

return:
JSON object only. No markdown, prose, XML, or legacy formats.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const PLANNER_TEMPLATE = plannerTemplate;

export const postCreationTemplate = `# Task: Create a post in the voice/style/perspective of {{agentName}} @{{xUserName}}.

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

Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from {{agentName}}'s perspective. No commentary, no acknowledgement, just the post.
1, 2, or 3 sentences (random length).
No questions. Brief, concise statements only. Total character count MUST be less than 280. No emojis. Use \\n\\n (double spaces) between statements.

Output JSON:
thought: Your thought here
post: Your post text here
imagePrompt: Optional image prompt here

"post": the post you want to send. No thinking or reflection.
"imagePrompt": optional, single sentence capturing the post's essence. Only use if the post benefits from an image.
"thought": short description of what the agent is thinking, with brief justification. Explain how the post is relevant but unique vs other posts.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const POST_CREATION_TEMPLATE = postCreationTemplate;

export const reflectionTemplate = `# Task: Reflect on recent agent behavior and interactions.

{{providers}}

# Recent Interactions:
{{recentInteractions}}

# Instructions:
Analyze recent behavior. Consider:
1. Communication clarity and helpfulness
2. Context appropriateness
3. Mistakes
4. Improvements

JSON:
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
- identify contact name to remove
- confirmed=yes only when user explicitly confirms
- confirmed=no when ambiguous or absent
- return only the requested contact

output:
JSON only. One JSON object. No prose, no <think>.

Example:
contactName: Jane Doe
confirmed: yes

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const REMOVE_CONTACT_TEMPLATE = removeContactTemplate;

export const replyTemplate = `# Task: Generate dialog for character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.
"thought": short description of what the agent is thinking and planning.
"text": next message {{agentName}} will send.

CODE BLOCK FORMATTING:
- For code examples, snippets, or multi-line code, ALWAYS wrap with \`\`\` fenced code blocks (specify language if known, e.g., \`\`\`python).
- ONLY use fenced blocks for actual code. Do NOT wrap non-code text in fences.
- For inline code (short single words or function names), use single backticks (\`).
- This ensures clean, copyable code formatting.

No <think> sections, no preamble.

JSON:
thought: Your thought here
text: Your message here

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const REPLY_TEMPLATE = replyTemplate;

export const scheduleFollowUpTemplate = `task: Extract follow-up scheduling info from the request.

context:
{{providers}}

current_message:
{{message}}

current_datetime:
{{currentDateTime}}

instructions[5]:
- identify who to follow up with
- entityId only when explicitly known
- convert timing to ISO datetime in scheduledAt
- normalize priority to high, medium, or low
- include message only when user asked for specific note or reminder text

output:
JSON only. One JSON object. No prose, no <think>.

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
- categories: comma-separated list when user filters by category
- tags: comma-separated list when user filters by tags
- searchTerm: name or free-text lookup
- intent=count when user wants a count, else list
- omit fields not clearly requested

output:
JSON only. One JSON object. No prose, no <think>.

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
- prior participation alone is not enough; newest message must clearly expect {{agentName}} -> otherwise IGNORE
- request to stop or be quiet directed at {{agentName}} -> STOP
- if multiple people mentioned and {{agentName}} is one of the addressees -> RESPOND
- in groups, if latest message is addressed to someone else, IGNORE
- when unsure, default IGNORE

available_contexts:
{{availableContexts}}

context_routing:
- contexts: zero or more context ids from available_contexts
- use [] when no tool or context provider is needed
- if contexts non-empty, planning runs and simple is ignored

decision_note:
- respond only when latest message is talking TO {{agentName}}
- talking TO {{agentName}}: name mention, reply chain, or clear follow-up
- mentions of others don't cancel direct address
- casual conversation between others is not enough
- if another assistant answered and nobody re-addressed, IGNORE
- if {{agentName}} replied recently and nobody re-addressed, IGNORE
- talking ABOUT {{agentName}} is not enough

output:
JSON only. One JSON object. No prose, no <think>.

Example:
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
- prior participation alone is not enough; newest message must clearly expect {{agentName}} -> otherwise IGNORE
- request to stop or be quiet directed at {{agentName}} -> STOP
- if multiple people mentioned and {{agentName}} is one of the addressees -> RESPOND
- in groups, if latest message is addressed to someone else, IGNORE
- when unsure, default IGNORE

available_contexts:
{{availableContexts}}

context_routing:
- contexts: zero or more context ids from available_contexts
- use [] when no tool or context provider is needed
- if contexts non-empty, planning runs and simple is ignored

decision_note:
- respond only when latest message is talking TO {{agentName}}
- talking TO {{agentName}}: name mention, reply chain, or clear follow-up
- mentions of others don't cancel direct address
- casual conversation between others is not enough
- if another assistant answered and nobody re-addressed, IGNORE
- if {{agentName}} replied recently and nobody re-addressed, IGNORE
- talking ABOUT {{agentName}} is not enough

output:
JSON only. One JSON object. No prose, no <think>.

Example:
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
- identify contact name to update
- operation=replace unless user clearly says add_to or remove_from
- categories and tags as comma-separated lists
- preferences and customFields as comma-separated key:value pairs
- include notes only when explicitly requested
- omit unchanged fields

output:
JSON only. One JSON object. No prose, no <think>.

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
Determine what to update. Only update fields user explicitly requested.

Example output:
thought: User asked to update Alice's email.
entity_id: ent_123
updates[1]{name,value}:
  email,alice@acme.com

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
- identify single entity whose role changes
- entity_id only when UUID is explicit in context
- normalize new_role to OWNER, ADMIN, MEMBER, GUEST, or NONE
- if removing elevated access without naming a new role, use NONE
- do not invent entity ids or roles
- include short thought describing the change

output:
JSON only. One JSON object. No prose, no <think>.

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
Determine which settings to update. Only update what user explicitly requested.

Example output:
thought: User asked to switch the default model to gpt-5.5.
updates[1]{key,value}:
  default_model,gpt-5.5

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const UPDATE_SETTINGS_TEMPLATE = updateSettingsTemplate;

export const updateSummarizationTemplate = `# Task: Update and Condense Conversation Summary

Update an existing summary with new messages, keeping it concise.

# Existing Summary
{{existingSummary}}

# Existing Topics
{{existingTopics}}

# New Messages Since Last Summary
{{newMessages}}

# Instructions
Update by:
1. Merging existing summary with new-message insights
2. Removing redundant or less important details
3. Keeping the most important context and decisions
4. Adding new topics as they emerge
5. **Keep ENTIRE updated summary under 2500 tokens**

Goal: rolling summary that captures conversation essence without growing indefinitely.

JSON:
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
