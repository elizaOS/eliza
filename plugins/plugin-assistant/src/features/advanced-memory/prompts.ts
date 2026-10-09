/** Authored templates for advanced memory behavior, preserving complete model context. */

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
- add_durable: claim, category, structured_fields, keywords; optional verification_status, reason.
- add_current: claim, category, structured_fields, keywords; optional valid_at, reason.
- strengthen: factId, optional reason.
- decay: factId, optional reason.
- contradict: factId, reason, optional proposedText.

For add_durable/add_current, include keywords: 3-8 lowercase retrieval terms.
Use stable nouns, proper names, symptoms, places, projects, dates, and
preferences. Omit stopwords and generic words.

For add_durable/add_current, fill structured_fields with flat string values
whenever the claim contains them. Use these English key names even when the
message is in another language:
- identity: preferredName, location/city, timezone, locale, orientation, gender, age.
- relationship: person or partnerName, relationshipType, relationshipStatus,
  platform, handle.
- business_role: company/organization/employer, person, relationshipType, role.
- preference: preferredNotificationChannel, travelBookingPreferences, locale.
- health/current state: condition, source, emotion, window.
- life_event/goal: event, to, goal, domain.
Omit unknown fields; do not invent values. Examples: "mi jefe es Pat" -> {"person":"Pat","relationshipType":"manager"}; "Je m'appelle Camille" -> {"preferredName":"Camille"}.

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
      "keywords": ["flat", "cortisol", "curve", "lab"],
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
      },
      "keywords": ["anxious", "morning"]
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
      },
      "keywords": ["moved", "tokyo", "relocation"]
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
- Significant impact on later work

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
- Formative experiences shaping later decisions

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
5. Return every qualifying extraction; never drop one to satisfy an item count

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
