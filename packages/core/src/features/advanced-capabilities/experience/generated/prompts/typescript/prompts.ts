/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../../prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const extractExperiencesTemplate = `# Task: Extract Novel Learning Experiences

Analyze this conversation for novel learning experiences that would be surprising or valuable to remember.

## Conversation context
{{conversation_context}}

## Existing similar experiences
{{existing_experiences}}

## Instructions
Extract ONLY experiences that are:
1. Genuinely novel (not in existing experiences)
2. Actionable learnings about how things work
3. Corrections of previous mistakes or assumptions
4. Discoveries of new capabilities or patterns
5. Surprising outcomes that contradict expectations

Focus on technical knowledge, patterns, and cause-effect relationships that transfer to other contexts.
Avoid personal details, user-specific information, or routine interactions.

Respond with TOON only. Return exactly one TOON document, no prose or fences.
Use an experiences table with max 3 rows:
experiences[1]{type,learning,context,confidence,reasoning}:
  DISCOVERY,What was learned,What triggered this,0.8,Why this is novel and valuable

Return this when no novel experiences are found:
experiences[0]:`;

export const EXTRACT_EXPERIENCES_TEMPLATE = extractExperiencesTemplate;
