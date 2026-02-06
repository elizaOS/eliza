/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../../prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

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

export const extractCompletionTemplate = `# Task: Extract Task Completion Information

## User Message
{{text}}

## Message History
{{messageHistory}}

## Available Tasks
{{availableTasks}}

## Instructions
Parse the user's message to identify which task they're marking as completed.
Match against the list of available tasks by name or description.
If multiple tasks have similar names, choose the closest match.

Return an XML object with:
<response>
  <taskId>ID of the task being completed, or 'null' if not found</taskId>
  <taskName>Name of the task being completed, or 'null' if not found</taskName>
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

export const EXTRACT_COMPLETION_TEMPLATE = extractCompletionTemplate;

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

export const extractTaskSelectionTemplate = `# Task: Extract Task Selection Information

## User Message
{{text}}

## Available Tasks
{{availableTasks}}

## Instructions
Parse the user's message to identify which task they want to update or modify.
Match against the list of available tasks by name or description.
If multiple tasks have similar names, choose the closest match.

Return an XML object with:
<response>
  <taskId>ID of the task being updated, or 'null' if not found</taskId>
  <taskName>Name of the task being updated, or 'null' if not found</taskName>
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

export const EXTRACT_TASK_SELECTION_TEMPLATE = extractTaskSelectionTemplate;

export const extractTaskUpdateTemplate = `# Task: Extract Task Update Information

## User Message
{{text}}

## Current Task Details
{{taskDetails}}

## Instructions
Parse the user's message to determine what changes they want to make to the task.
Only include fields that the user explicitly wants to update.

Return an XML object with these potential fields (only include fields that should be changed):
<response>
  <name>New name for the task</name>
  <description>New description for the task</description>
  <priority>New priority (1-4, where 1 is highest)</priority>
  <urgent>'true' or 'false' for whether the task is urgent</urgent>
  <dueDate>New due date in ISO format (YYYY-MM-DD), or 'null' to remove the due date</dueDate>
  <recurring>New recurrence pattern ('daily', 'weekly', 'monthly')</recurring>
</response>

## Example Output Format
<response>
  <description>Updated task description</description>
  <priority>2</priority>
  <dueDate>2023-04-30</dueDate>
</response>`;

export const EXTRACT_TASK_UPDATE_TEMPLATE = extractTaskUpdateTemplate;

export const extractTodoTemplate = `# Task: Extract Todo Information

## User Message
{{text}}

## Message History
{{messageHistory}}

## Instructions
Parse the user's message (within the context of the message history) to extract information for creating a new todo/task. Don't write a program or any code, just generate and return the XML object.
Identify whether this is a daily recurring task, a one-off task with a due date, or an aspirational goal.

**IMPORTANT:** If the user message appears to be a simple confirmation (e.g., "yes", "confirm", "ok", "looks good", "do it"), and NOT a description of a new task, return an empty response like <response></response> or a response with a clear indication like <is_confirmation>true</is_confirmation> instead of trying to extract task details.

Return an XML object with these fields:
<response>
  <name>A concise name for the task</name>
  <description>Optional detailed description</description>
  <taskType>One of "daily", "one-off", "aspirational"</taskType>
  <priority>For one-off tasks, a number from 1-4 (1=highest, 4=lowest), default to 3 if not specified</priority>
  <urgent>For one-off tasks, 'true' or 'false' indicating if urgent, default 'false'</urgent>
  <dueDate>For one-off tasks with due dates, ISO date string (YYYY-MM-DD)</dueDate>
  <recurring>For daily tasks, frequency ("daily", "weekly", "monthly"), default to "daily"</recurring>
</response>

Use only the information provided by the user. Do not invent details.
If task type is unspecified, assume it's a one-off task.
If priority is unspecified, use 3 (medium priority).
Do not write code. Just return the XML object.

## Example Output Format
<response>
  <name>Finish my taxes</name>
  <description>Get all the documents together and file online</description>
  <taskType>one-off</taskType>
  <priority>2</priority>
  <urgent>false</urgent>
  <dueDate>2024-04-15</dueDate>
</response>`;

export const EXTRACT_TODO_TEMPLATE = extractTodoTemplate;
