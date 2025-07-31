export const defaultSuggestionPrompt = (ctx: {
  conversation: string;
}) => `<task>
If asked a question, suggest answers, also suggest conversation topics based on agent's capabilities
</task>
<conversation>
${ctx.conversation}
</conversation>
<capabilities>
- Analyze portfolio
- Suggest strategy
- Swap tokens
- Crypto news
</capabilities>
<instructions>
Look at the last message from agent.
If it includes a question suggest answers, eg. "Agent: Are you sure to continue?" - ["Yes", "No"], "Agent: I han give you some options: 1. You can go south 2. You can go north 3. You can go east If you are interested I can tell you more." - ["South", "North", "East"]
Additionally, generate 4 suggestions based on capabilities, eg. ["My Assets", "Select strategy", "Swap tokens", "Crypto news"] 
Text for the message should be detailed, eg, "label": "My Assets" -> "text": "Please, tell me about my portfolio", or "label": "Select strategy" -> "text": "Please help me to select a strategy"
</instructions>
<keys>
- "suggestions" should be an array of objects with the following keys:
  - "label" - short description of the suggestion
  - "text" - full message
</keys>
<output>
Respond using JSON format like this:
{
  "suggestions": 
    {
      "label": string,
      "text": string,
    }[]

Your response should include the valid JSON block and nothing else.
</output>`;
