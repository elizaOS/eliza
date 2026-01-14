//! Auto-generated prompt templates
//! DO NOT EDIT - Generated from ../../../../prompts/*.txt
//!
//! These prompts use Handlebars-style template syntax:
//! - {{variableName}} for simple substitution
//! - {{#each items}}...{{/each}} for iteration
//! - {{#if condition}}...{{/if}} for conditionals

pub const INITIAL_SUMMARIZATION_TEMPLATE: &str = r#"# Task: Summarize Conversation

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
</summary>"#;

pub const LONG_TERM_EXTRACTION_TEMPLATE: &str = r#"# Task: Extract Long-Term Memory (Strict Criteria)

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

## ✅ DO EXTRACT (Only These):

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

## ❌ NEVER EXTRACT:

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

**If there are no qualifying facts (which is common), respond with <memories></memories>**

# Response Format

<memories>
  <memory>
    <category>semantic</category>
    <content>User is a senior TypeScript developer with 8 years of backend experience</content>
    <confidence>0.95</confidence>
  </memory>
  <memory>
    <category>procedural</category>
    <content>User follows TDD workflow: writes tests before implementation, runs tests after each change</content>
    <confidence>0.88</confidence>
  </memory>
  <memory>
    <category>episodic</category>
    <content>User led database migration from MongoDB to PostgreSQL for payment system in Q2 2024</content>
    <confidence>0.92</confidence>
  </memory>
</memories>"#;

pub const UPDATE_SUMMARIZATION_TEMPLATE: &str = r#"# Task: Update and Condense Conversation Summary

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
</summary>"#;

