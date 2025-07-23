import { EnumWithDescription, enumWithDescription } from "./util";

/** @deprecated needs refactoring */
export const suggestTypeTemplate = (
  types: EnumWithDescription[]
) => `<task>Select the most suitable suggest type for user's next message.</task>
<conversation>
{{conversation}}
</conversation>

These are the available suggestion types:
<suggestionTypes>
${enumWithDescription(types)}
</suggestionTypes>
<user>
{{userData}}
</user>
<instructions>
Select relevant data provided by user's responses and decide which suggestion type is best suited for user's next message.

IMPORTANT DATA SELECTION RULES;
- If user asked to cancel transaction, no KNOWN data can be selected before the cancel.
- If user confirmed transaction, no KNOWN data can be selected before the confirmation.
- Ignore data if it was provided as an example by an agent.

First, decide what data is KNOWN and which field is UNKNOWN. Then select the most suitable suggestion type. If you cannot find any data, select the most general suggestion type.
</instructions>
<keys>
- "thought" should be a short description of what the agent is thinking about and planning.
- "type" should have one of the following values: ${types.map((item) => `"${item.name}"`).join(", ")}
- "known" should be a JSON object
- "unknown" should be an array of strings
</keys>
<output>
Respond using JSON format like this:
{
  "thought": "<string>",
  "type": "<${types.map((item) => `"${item.name}"`).join(" | ")}>",
  "known": "<object>",
  "unknown": "<array>"
}

Your response should include the valid JSON block and nothing else.
</output>`;
