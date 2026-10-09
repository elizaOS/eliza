/** Authored templates for autonomy behavior, preserving complete model context. */

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
{
  "thought": "Continuing from prior note; nothing new to act on.",
  "actions": []
}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const AUTONOMY_CONTINUOUS_CONTINUE_TEMPLATE =
  autonomyContinuousContinueTemplate;

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
{
  "thought": "Inspecting current state; nothing to act on this round.",
  "actions": []
}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const AUTONOMY_CONTINUOUS_FIRST_TEMPLATE =
  autonomyContinuousFirstTemplate;

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
{
  "thought": "Waiting on prior step to complete; nothing to do this round.",
  "actions": []
}

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
{
  "thought": "Need to gather UI state before acting.",
  "actions": [
    {
      "name": "COMPUTER_USE_INSPECT",
      "parameters": {}
    }
  ]
}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const AUTONOMY_TASK_FIRST_TEMPLATE = autonomyTaskFirstTemplate;
