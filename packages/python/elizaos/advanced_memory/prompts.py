INITIAL_SUMMARIZATION_TEMPLATE = """# Task: Summarize Conversation

You are analyzing a conversation to create a concise summary that captures the key points, topics, and important details.

# Recent Messages
{recent_messages}

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
</summary>"""

UPDATE_SUMMARIZATION_TEMPLATE = """# Task: Update and Condense Conversation Summary

You are updating an existing conversation summary with new messages, while keeping the total summary concise.

# Existing Summary
{existing_summary}

# Existing Topics
{existing_topics}

# New Messages Since Last Summary
{new_messages}

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
</summary>"""

LONG_TERM_EXTRACTION_TEMPLATE = """# Task: Extract Long-Term Memory (Strict Criteria)

You are analyzing a conversation to extract ONLY the most critical, persistent information about the user using cognitive science memory categories.

# Recent Messages
{recent_messages}

# Current Long-Term Memories
{existing_memories}

# ULTRA-STRICT EXTRACTION CRITERIA

Default to NOT extracting. Confidence must be >= 0.85.
If there are no qualifying facts, respond with <memories></memories>

# Response Format

<memories>
  <memory>
    <category>semantic</category>
    <content>User is a senior TypeScript developer with 8 years of backend experience</content>
    <confidence>0.95</confidence>
  </memory>
</memories>"""

