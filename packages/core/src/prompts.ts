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

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
contactName: Jane Doe
entityId:
categories: vip,colleague
notes: Met at the design summit
timezone: America/New_York
language: English
reason: Important collaborator to remember`;

export const ADD_CONTACT_TEMPLATE = addContactTemplate;

export const autonomyContinuousContinueTemplate = `Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- Use thinking to think about and plan what you want to do.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: a JSON object with a thought field plus an optional actions list. No other message text. No XML or markdown fences.
- If you don't need to make a change this round, take no action and output only the thought field with an empty actions value.
- If you cannot act, explain what is missing inside thought and take no action.
- Keep the response concise, focused on the next action.

USER CONTEXT (most recent last):
{{targetRoomContext}}

Your last autonomous note: "{{lastThought}}"

Continue from that note. Output a JSON thought and take action if needed.

Example (no action this round):
thought: Continuing from prior note; nothing new to act on.
actions:`;

export const AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE =
	autonomyContinuousContinueTemplate;

export const autonomyContinuousFirstTemplate = `Your job: reflect on context, decide what you want to do next, and act if appropriate.
- Use available actions/tools when they can advance the goal.
- Use thinking to think about and plan what you want to do.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: a JSON object with a thought field plus an optional actions list. No other message text. No XML or markdown fences.
- If you don't need to make a change this round, take no action and output only the thought field with an empty actions value.
- If you cannot act, explain what is missing inside thought and take no action.
- Keep the response concise, focused on the next action.

USER CONTEXT (most recent last):
{{targetRoomContext}}

Think briefly, then output a JSON thought and take action if needed.

Example (no action this round):
thought: Inspecting current state; nothing to act on this round.
actions:`;

export const AUTONOMY_CONTINUOUS_FIRST_TEMPLATE =
	autonomyContinuousFirstTemplate;

export const autonomyTaskContinueTemplate = `You are running in AUTONOMOUS TASK MODE.

Your job: continue helping the user and make progress toward the task.
- Use available actions/tools to gather information or execute steps.
- Use thinking to think about and plan what you want to do.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: a JSON object with a thought field plus an optional actions list. No other message text. No XML or markdown fences.
- If you don't need to make a change this round, take no action and output only the thought field with an empty actions value.
- If you cannot act, explain what is missing inside thought and take no action.
- Keep the response concise, focused on the next action.

USER CHAT CONTEXT (most recent last):
{{targetRoomContext}}

Your last autonomous note: "{{lastThought}}"

Continue the task. Output a JSON thought and take action now.

Example (no action this round):
thought: Waiting on prior step to complete; nothing to do this round.
actions:`;

export const AUTONOMY_TASK_CONTINUE_TEMPLATE = autonomyTaskContinueTemplate;

export const autonomyTaskFirstTemplate = `You are running in AUTONOMOUS TASK MODE.

Your job: continue helping the user and make progress toward the task.
- Use available actions/tools to gather information or execute steps.
- If you need UI control, use ComputerUse actions.
- In MCP mode, selector-based actions require a process scope (pass process=... or prefix selector with "process:<name> >> ...").
- Prefer safe, incremental steps; if unsure, gather more UI context before acting.
- Do NOT speak out loud. This loop is internal-only.
- Output structure: a JSON object with a thought field plus an optional actions list. No other message text. No XML or markdown fences.

USER CHAT CONTEXT (most recent last):
{{targetRoomContext}}

Decide what to do next. Output a JSON thought, then take the most useful action.

Example:
thought: Need to gather UI state before acting.
actions[1]:
  - name: COMPUTER_USE_INSPECT`;

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

IMPORTANT: Your response must ONLY contain the JSON object above.`;

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

Output JSON only. Return exactly one JSON object, no prose or fences.
Use only these fields:
operation: get|set|delete|list|check
key: OPENAI_API_KEY
value: secret_value
level: global|world|user
description: short_description
type: api_key|secret|credential|url|config

Omit unknown optional fields. No XML or JSON.`;

export const EXTRACT_SECRET_OPERATION_TEMPLATE = extractSecretOperationTemplate;

export const extractSecretRequestTemplate = `You are helping an AI agent request a missing secret.
Determine what secret the agent needs and why based on the recent conversation.

Common patterns:
- "I need an API key for OpenAI" -> key: OPENAI_API_KEY
- "Missing TWITTER_TOKEN" -> key: TWITTER_TOKEN
- "I cannot proceed without a Discord token" -> key: DISCORD_TOKEN

Recent Messages:
{{recentMessages}}

Output JSON only. Return exactly one JSON object, no prose or fences.
Use:
key: OPENAI_API_KEY
reason: why it is needed

If no specific secret is requested, leave key empty. No XML or JSON.`;

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

Output JSON only. Return exactly one JSON object, no prose or fences.
Use:
secrets[n]{key,value,description,type}:
level: global|world|user

Omit description/type/level when unknown. No XML or JSON.`;

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
JSON only. Return exactly one JSON object. No prose, no fences, no XML, no <think>.
If nothing should change, return:
{"ops":[]}`;

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

IMPORTANT: Your response must ONLY contain the JSON object above. Do not include any text, thinking, or reasoning before or after it.`;

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

IMPORTANT: Your response must ONLY contain the JSON object above.`;

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
keyPoints[1]: Second key point`;

export const INITIAL_SUMMARIZATION_TEMPLATE = initialSummarizationTemplate;

export const longTermExtractionTemplate = `# Task: Extract Long-Term Memory (Strict Criteria)

You are analyzing a conversation to extract ONLY the most critical, persistent information about the user using cognitive science memory categories.

# Recent Messages
{{recentMessages}}

# Current Long-Term Memories
{{existingMemories}}

# Memory Categories (Based on Cognitive Science)

## 1. EPISODIC Memory
Personal experiences and specific events with temporal/spatial context.
**Examples:**
- "User completed migration project from MongoDB to PostgreSQL in Q2 2024"
- "User encountered authentication bug in production on March 15th"
- "User had a negative experience with Docker networking in previous job"

**Requirements:**
- Must include WHO did WHAT, WHEN/WHERE
- Must be a specific, concrete event (not a pattern)
- Must have significant impact or relevance to future work

## 2. SEMANTIC Memory
General facts, concepts, knowledge, and established truths about the user.
**Examples:**
- "User is a senior backend engineer with 8 years experience"
- "User specializes in distributed systems and microservices architecture"
- "User's primary programming language is TypeScript"
- "User works at Acme Corp as technical lead"

**Requirements:**
- Must be factual, timeless information
- Must be explicitly stated or demonstrated conclusively
- No speculation or inference from single instances
- Core identity, expertise, or knowledge only

## 3. PROCEDURAL Memory
Skills, workflows, methodologies, and how-to knowledge.
**Examples:**
- "User follows strict TDD workflow: write tests first, then implementation"
- "User prefers git rebase over merge to maintain linear history"
- "User's debugging process: check logs → reproduce locally → binary search"
- "User always writes JSDoc comments before implementing functions"

**Requirements:**
- Must describe HOW user does something
- Must be a repeated, consistent pattern (seen 3+ times or explicitly stated as standard practice)
- Must be a workflow, methodology, or skill application
- Not one-off preferences

# ULTRA-STRICT EXTRACTION CRITERIA

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
- Debugging, testing, or development processes

## NEVER EXTRACT:

- **One-time requests or tasks** (e.g., "can you generate an image", "help me debug this")
- **Casual conversations** without lasting significance
- **Exploratory questions** (e.g., "how does X work?")
- **Temporary context** (current bug, today's task)
- **Preferences from single occurrence** (e.g., user asked for code once)
- **Social pleasantries** (thank you, greetings)
- **Testing or experimentation** (trying out a feature)
- **Common patterns everyone has** (likes clear explanations)
- **Situational information** (working on feature X today)
- **Opinions without persistence** (single complaint, isolated praise)
- **General knowledge** (not specific to user)

# Quality Gates (ALL Must Pass)

1. **Significance Test**: Will this matter in 3+ months?
2. **Specificity Test**: Is this concrete and actionable?
3. **Evidence Test**: Is there strong evidence (3+ instances OR explicit self-identification)?
4. **Uniqueness Test**: Is this specific to THIS user (not generic)?
5. **Confidence Test**: Confidence must be >= 0.85 (be VERY conservative)
6. **Non-Redundancy Test**: Does this add NEW information not in existing memories?

# Confidence Scoring (Be Conservative)

- **0.95-1.0**: User explicitly stated as core identity/practice AND demonstrated multiple times
- **0.85-0.94**: User explicitly stated OR consistently demonstrated 5+ times
- **0.75-0.84**: Strong pattern (3-4 instances) with supporting context
- **Below 0.75**: DO NOT EXTRACT (insufficient evidence)

# Critical Instructions

1. **Default to NOT extracting** - When in doubt, skip it
2. **Require overwhelming evidence** - One or two mentions is NOT enough
3. **Focus on what's PERSISTENT** - Not what's temporary or situational
4. **Verify against existing memories** - Don't duplicate or contradict
5. **Maximum 2-3 extractions per run** - Quality over quantity

**If there are no qualifying facts (which is common), return no memories entries.**

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
  confidence: 0.92`;

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
JSON only. Return exactly one JSON object with the keys above. No prose before or after it. No <think>. No XML or markdown fences.

Example:
{
  "action": "RESPOND",
  "simple": true,
  "contexts": [],
  "thought": "The user asked a direct conversational question that needs no tools.",
  "reply": "Your message here"
}`;

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

IMPORTANT: Your response must ONLY contain the JSON object above. Do not include any text, thinking, or reasoning before or after it.`;

export const OPTION_EXTRACTION_TEMPLATE = optionExtractionTemplate;

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


IMPORTANT: Your response must ONLY contain the JSON object above. Do not include any text, thinking, or reasoning before or after it.`;

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
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.
Do not output JSON, XML, Markdown fences, or commentary.
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

IMPORTANT: Your response must ONLY contain the JSON object above. Do not include any text, thinking, or reasoning before or after it.`;

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

IMPORTANT: Your response must ONLY contain the JSON object above.`;

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

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
contactName: Jane Doe
confirmed: yes`;

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

IMPORTANT: Your response must ONLY contain the JSON object above. Do not include any text, thinking, or reasoning before or after it.`;

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

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
contactName: Jane Doe
entityId:
scheduledAt: 2026-04-06T14:00:00.000Z
reason: Check in on the proposal
priority: medium
message: Send the latest deck before the call`;

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

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
categories: vip,colleague
searchTerm: Jane
tags: ai,design
intent: list`;

export const SEARCH_CONTACTS_TEMPLATE = searchContactsTemplate;

export const shouldFollowRoomTemplate = `task: Decide whether {{agentName}} should follow this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user is clearly asking {{agentName}} to follow, join, listen to, or stay engaged in this room
- return false when the request is ambiguous or unrelated
- prefer false when uncertain

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
decision: true`;

export const SHOULD_FOLLOW_ROOM_TEMPLATE = shouldFollowRoomTemplate;

export const shouldMuteRoomTemplate = `task: Decide whether {{agentName}} should mute this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user is clearly asking {{agentName}} to mute, silence, or ignore this room
- return false when the request is ambiguous or unrelated
- prefer false when uncertain

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

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
- if unsure whether the speaker is talking to {{agentName}}, prefer IGNORE over hallucinating relevance

available_contexts:
{{availableContexts}}

context_routing:
- contexts: list zero or more context ids from available_contexts
- use [] when no tool or context provider is needed
- if contexts is non-empty, planning will run and simple will be ignored

decision_note:
- respond only when the latest message is talking TO {{agentName}}
- talking TO {{agentName}} means name mention, reply chain, or a clear follow-up that still expects {{agentName}} to answer
- mentions of other people do not cancel a direct address to {{agentName}}
- casual conversation between other users is not enough
- if another assistant already answered and nobody re-addressed {{agentName}}, IGNORE
- if {{agentName}} already replied recently and nobody re-addressed {{agentName}}, IGNORE
- talking ABOUT {{agentName}} or continuing a room conversation around them is not enough

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
{
  "action": "RESPOND",
  "simple": true,
  "contexts": [],
  "thought": "Direct mention and clear follow-up.",
  "reply": "Short direct reply when no context is needed."
}`;

export const SHOULD_RESPOND_TEMPLATE = shouldRespondTemplate;

export const shouldRespondWithContextTemplate = `task: Decide whether {{agentName}} should respond and which domain contexts apply.

context:
{{providers}}

available_contexts:
{{availableContexts}}

rules[7]:
- direct mention of {{agentName}} -> RESPOND
- different assistant name or talking to someone else -> IGNORE unless {{agentName}} is also directly addressed
- prior participation by {{agentName}} in the thread is not enough by itself; the newest message must still clearly expect {{agentName}} -> otherwise IGNORE
- request to stop or be quiet directed at {{agentName}} -> STOP
- if multiple people are mentioned and {{agentName}} is one of the addressees -> RESPOND
- in group conversations, if the latest message is addressed to someone else and not to {{agentName}}, IGNORE
- if unsure whether the speaker is talking to {{agentName}}, prefer IGNORE over hallucinating relevance

context_routing:
- contexts: zero or more matching domains from available_contexts
- action intent does not only come from the last message; consider the full recent conversation
- if no specific domain applies, use []

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
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
{
  "action": "RESPOND",
  "simple": false,
  "contexts": ["wallet"],
  "thought": "Direct mention asking about token balance."
}`;

export const SHOULD_RESPOND_WITH_CONTEXT_TEMPLATE =
	shouldRespondWithContextTemplate;

export const shouldUnfollowRoomTemplate = `task: Decide whether {{agentName}} should unfollow this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user is clearly asking {{agentName}} to stop following or leave this room
- return false when the request is ambiguous or unrelated
- prefer false when uncertain

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
decision: true`;

export const SHOULD_UNFOLLOW_ROOM_TEMPLATE = shouldUnfollowRoomTemplate;

export const shouldUnmuteRoomTemplate = `task: Decide whether {{agentName}} should unmute this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user is clearly asking {{agentName}} to unmute or resume listening to this room
- return false when the request is ambiguous or unrelated
- prefer false when uncertain

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
decision: true`;

export const SHOULD_UNMUTE_ROOM_TEMPLATE = shouldUnmuteRoomTemplate;

export const thinkTemplate = `# Task: Think deeply and reason carefully for {{agentName}}.

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

Respond using JSON:
thought: Your detailed internal reasoning — the full chain of thought, alternatives considered, and why you reached your conclusion
text: Your response to the user — clear, structured, and well-reasoned. Use headings, lists, or code blocks as appropriate for the content.

IMPORTANT: Your response must ONLY contain the JSON object above. Do not include any preamble or explanation outside of it.`;

export const THINK_TEMPLATE = thinkTemplate;

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

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
contactName: Jane Doe
operation: add_to
categories: vip
tags: ai,friend
preferences: timezone:America/New_York,language:English
customFields: company:Acme,title:Designer
notes: Prefers async communication`;

export const UPDATE_CONTACT_TEMPLATE = updateContactTemplate;

export const updateEntityTemplate = `# Task: Update entity information.

{{providers}}

# Current Entity Information:
{{entityInfo}}

# Instructions:
Based on the request, determine what information about the entity should be updated.
Only update fields that the user has explicitly requested to change.

Respond using JSON like this:
thought: Your reasoning for the entity update
entity_id: The entity ID to update
updates[1]{name,value}:
  field_name,new_value

IMPORTANT: Your response must ONLY contain the JSON object above.`;

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

output:
JSON only. Return exactly one JSON object. No prose before or after it. No <think>.

Example:
thought: Sarah should become an admin.
entity_id: 00000000-0000-0000-0000-000000000000
new_role: ADMIN`;

export const UPDATE_ROLE_TEMPLATE = updateRoleTemplate;

export const updateSettingsTemplate = `# Task: Update settings based on the request.

{{providers}}

# Current Settings:
{{settings}}

# Instructions:
Based on the request, determine which settings to update.
Only update settings that the user has explicitly requested.

Respond using JSON like this:
thought: Your reasoning for the settings changes
updates[1]{key,value}:
  setting_key,new_value

IMPORTANT: Your response must ONLY contain the JSON object above.`;

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
keyPoints[1]: Second key point`;

export const UPDATE_SUMMARIZATION_TEMPLATE = updateSummarizationTemplate;

export const booleanFooter = "Respond with only a YES or a NO.";

export const BOOLEAN_FOOTER = booleanFooter;
