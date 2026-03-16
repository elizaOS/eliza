/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../../prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const checkSimilarityTemplate = `# Task: Check Goal Similarity

## New Goal
Name: {{newGoalName}}
Description: {{newGoalDescription}}

## Existing Goals
{{existingGoals}}

## Instructions
Determine if the new goal is similar to any existing goals.
Consider goals similar if they have the same objective, even if worded differently.

Return an XML object:
<response>
  <hasSimilar>true or false</hasSimilar>
  <similarGoalName>Name of the similar goal if found</similarGoalName>
  <confidence>0-100 indicating confidence in similarity</confidence>
</response>

## Example
New Goal: "Get better at public speaking"
Existing Goal: "Improve presentation skills"
These are similar (confidence: 85)`;

export const CHECK_SIMILARITY_TEMPLATE = checkSimilarityTemplate;

export const extractCancellationTemplate = `# Task: Extract Task Cancellation Information

## User Message
{{text}}

## Message History
{{messageHistory}}

## Available Tasks
{{availableTasks}}

## Instructions
Parse the user's message to identify which task they want to cancel or delete.
Match against the list of available tasks by name or description.
If multiple tasks have similar names, choose the closest match.

Return an XML object with:
<response>
  <taskId>ID of the task being cancelled, or 'null' if not found</taskId>
  <taskName>Name of the task being cancelled, or 'null' if not found</taskName>
  <isFound>'true' or 'false' indicating if a matching task was found</isFound>
</response>

## Example Output Format
<response>
  <taskId>123e4567-e89b-12d3-a456-426614174000</taskId>
  <taskName>Finish report</taskName>
  <isFound>true</isFound>
</response>

If no matching task was found:
<response>
  <taskId>null</taskId>
  <taskName>null</taskName>
  <isFound>false</isFound>
</response>`;

export const EXTRACT_CANCELLATION_TEMPLATE = extractCancellationTemplate;

export const extractConfirmationTemplate = `# Task: Extract Confirmation Intent

## User Message
{{text}}

## Message History
{{messageHistory}}

## Pending Task Details
{{pendingTask}}

## Instructions
Determine if the user is confirming, rejecting, or modifying the pending task creation.
Look for:
- Affirmative responses (yes, confirm, ok, do it, go ahead, etc.)
- Negative responses (no, cancel, nevermind, stop, etc.)
- Modification requests (change X to Y, make it priority 1, etc.)

Return an XML object with:
<response>
  <isConfirmation>true/false - whether this is a response to the pending task</isConfirmation>
  <shouldProceed>true/false - whether to create the task</shouldProceed>
  <modifications>Any requested changes to the task, or 'none'</modifications>
</response>

## Example Output
<response>
  <isConfirmation>true</isConfirmation>
  <shouldProceed>true</shouldProceed>
  <modifications>none</modifications>
</response>`;

export const EXTRACT_CONFIRMATION_TEMPLATE = extractConfirmationTemplate;

export const extractGoalSelectionTemplate = `# Task: Extract Goal Selection Information

## User Message
{{text}}

## Available Goals
{{availableGoals}}

## Instructions
Parse the user's message to identify which goal they want to update or modify.
Match against the list of available goals by name or description.
If multiple goals have similar names, choose the closest match.

Return an XML object with:
<response>
  <goalId>ID of the goal being updated, or 'null' if not found</goalId>
  <goalName>Name of the goal being updated, or 'null' if not found</goalName>
  <isFound>'true' or 'false' indicating if a matching goal was found</isFound>
</response>

## Example Output Format
<response>
  <goalId>123e4567-e89b-12d3-a456-426614174000</goalId>
  <goalName>Learn French fluently</goalName>
  <isFound>true</isFound>
</response>

If no matching goal was found:
<response>
  <goalId>null</goalId>
  <goalName>null</goalName>
  <isFound>false</isFound>
</response>`;

export const EXTRACT_GOAL_SELECTION_TEMPLATE = extractGoalSelectionTemplate;

export const extractGoalTemplate = `# Task: Extract Goal Information

## User Message
{{text}}

## Message History
{{messageHistory}}

## Instructions
Parse the user's message to extract information for creating a new goal.
Determine if this goal is for the agent itself or for tracking a user's goal.

Goals should be long-term achievable objectives, not short-term tasks.

Return an XML object with these fields:
<response>
  <name>A clear, concise name for the goal</name>
  <description>Optional detailed description</description>
  <ownerType>Either "agent" (for agent's own goals) or "entity" (for user's goals)</ownerType>
</response>

If the message doesn't clearly indicate a goal to create, return empty response.

## Example Output Format
<response>
  <name>Learn Spanish fluently</name>
  <description>Achieve conversational fluency in Spanish within 6 months</description>
  <ownerType>entity</ownerType>
</response>`;

export const EXTRACT_GOAL_TEMPLATE = extractGoalTemplate;

export const extractGoalUpdateTemplate = `# Task: Extract Goal Update Information

## User Message
{{text}}

## Current Goal Details
{{goalDetails}}

## Instructions
Parse the user's message to determine what changes they want to make to the goal.
Only name and description can be updated.

Return an XML object with these potential fields (only include fields that should be changed):
<response>
  <name>New name for the goal</name>
  <description>New description for the goal</description>
</response>

## Example Output Format
<response>
  <name>Learn Spanish fluently</name>
  <description>Achieve conversational fluency in Spanish within 12 months</description>
</response>`;

export const EXTRACT_GOAL_UPDATE_TEMPLATE = extractGoalUpdateTemplate;

