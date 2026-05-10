export const FIELD_CORRECTION_SYSTEM_PROMPT = `Fix the workflows field reference to use a valid field path.

You will receive:
1. A $json reference with an invalid field
2. The available fields with their types from the source node's output schema

Pick the field that best matches the intent. Pay attention to types: if the expression expects text content, pick a string field, not an object or array.

Return ONLY the corrected $json reference. No explanation, no {{ }} wrapping.

Example:
- Expression: $json.sender
- Available: from.value[0].address (string), from.value[0].name (string), subject (string), id (string)
- Output: $json.from.value[0].address`;

export const FIELD_CORRECTION_USER_PROMPT = `Expression: {expression}
Available fields:
{availableFields}

Return the corrected expression:`;
