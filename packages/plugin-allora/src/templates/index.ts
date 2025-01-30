export const getInferenceTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.
Example response:
\`\`\`json
{
    "topicId": 1,
    "topicName": "Topic Name",
}
\`\`\`

Recent messages:
{{recentMessages}}

Allora Network Topics:
{{alloraTopics}}

Given the recent messages and the Allora Network Topics above, extract the following information about the requested:
- Topic ID of the topic that best matches the user's request. The topic should be active, otherwise return null.
- Topic Name of the topic that best matches the user's request. The topic should be active, otherwise return null.

If the topic is not active or the inference timeframe is not matching the user's request, return null for both topicId and topicName.

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined. The result should be a valid JSON object with the following schema:
\`\`\`json
{
    "topicId": number | null,
    "topicName": string | null,
}
\`\`\``;
