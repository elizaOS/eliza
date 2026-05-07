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

Respond with JSON only, with no prose, markdown, or code fences:
{
  "text": "Your comprehensive summary here",
  "topics": ["topic1", "topic2", "topic3"],
  "keyPoints": ["First key point", "Second key point"]
}`;

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

Respond with JSON only, with no prose, markdown, or code fences:
{
  "text": "Your updated and condensed summary here",
  "topics": ["topic1", "topic2", "topic3"],
  "keyPoints": ["First key point", "Second key point"]
}`;

export const longTermExtractionTemplate = `# Task: Extract Long-Term Memory (Strict Criteria)

You are analyzing a conversation to extract ONLY the most critical, persistent information about the user using cognitive science memory categories.

# Recent Messages
{{recentMessages}}

# Current Long-Term Memories
{{existingMemories}}

# Memory Categories (Based on Cognitive Science)

## 1. EPISODIC Memory
Personal experiences and specific events with temporal/spatial context.

## 2. SEMANTIC Memory
General facts, concepts, knowledge, and established truths about the user.

## 3. PROCEDURAL Memory
Skills, workflows, methodologies, and how-to knowledge.

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

- One-time requests or tasks
- Casual conversations without lasting significance
- Exploratory questions
- Temporary context
- Preferences from single occurrence
- Social pleasantries
- Testing or experimentation
- Common patterns everyone has
- Situational information
- Opinions without persistence
- General knowledge

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
- **Below 0.75**: DO NOT EXTRACT

# Critical Instructions

1. **Default to NOT extracting**
2. **Require overwhelming evidence**
3. **Focus on what's PERSISTENT**
4. **Verify against existing memories**
5. **Maximum 2-3 extractions per run**

If there are no qualifying facts, return no memories entries.

# Response Format

Respond with JSON only, with no prose, markdown, or code fences:

{
  "memories": [
    {
      "category": "semantic",
      "content": "User is a senior TypeScript developer with 8 years of backend experience",
      "confidence": 0.95
    },
    {
      "category": "procedural",
      "content": "User follows TDD workflow: writes tests before implementation, runs tests after each change",
      "confidence": 0.88
    }
  ]
}`;
