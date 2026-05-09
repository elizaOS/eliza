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

Return a JSON object with an experiences array containing at most 3 rows.
Each row must include type, learning, context, confidence, and reasoning.

Return this when no novel experiences are found:
{ "experiences": [] }`;

export const EXTRACT_EXPERIENCES_TEMPLATE = extractExperiencesTemplate;
