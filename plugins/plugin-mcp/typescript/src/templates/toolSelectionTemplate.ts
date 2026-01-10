export const toolSelectionNameTemplate = `
{{mcpProvider.text}}

{{recentMessages}}

# TASK: Select the Most Appropriate Tool and Server

You must select the most appropriate tool from the list above to fulfill the user's request. Your response must be a valid JSON object with the required properties.

## CRITICAL INSTRUCTIONS
1. Provide both "serverName" and "toolName" from the options listed above.
2. Each name must match EXACTLY as shown in the list:
   - Example (correct): "serverName": "github"
   - Example (incorrect): "serverName": "GitHub", "Github", or variations
3. Extract ACTUAL parameter values from the conversation context.
   - Do not invent or use placeholders like "octocat" or "Hello-World" unless the user said so.
4. Include a "reasoning" field explaining why the selected tool fits the request.
5. If no tool is appropriate, respond with:
   {
     "noToolAvailable": true
   }

!!! YOUR RESPONSE MUST BE A VALID JSON OBJECT ONLY !!! 

CRITICAL: Your response must START with { and END with }. DO NOT include ANY text before or after the JSON.

## STRICT FORMAT REQUIREMENTS
- The response MUST be a single valid JSON object.
- DO NOT wrap the JSON in triple backticks (\`\`\`), code blocks, or include any explanatory text.
- DO NOT include comments (// or /* */) anywhere.
- DO NOT use placeholders (e.g., "replace with...", "example", "your...", etc.)
- ALL strings must use double quotes.

## CRITICAL NOTES
- All values must be fully grounded in user input or inferred contextually.
- No missing fields unless they are explicitly optional in the schema.
- All types must match the schema (strings, numbers, booleans).

## JSON OBJECT STRUCTURE
Your response MUST contain ONLY these top-level keys:
1. "serverName" — The name of the server (e.g., "github", "notion")
2. "toolName" — The name of the tool (e.g., "get_file_contents", "search")
3. "reasoning" — A string explaining how the values were inferred from the conversation.
4. "noToolAvailable" — A boolean indicating if no tool is available (true/false)

## EXAMPLE RESPONSE
{
  "serverName": "github",
  "toolName": "get_file_contents",
  "reasoning": "The user wants to retrieve the README from the facebook/react repository.",
  "noToolAvailable": false
}

## REMINDERS
- Use "github" as serverName for GitHub tools.
- Use "notion" as serverName for Notion tools.
- For search and knowledge-based tasks, MCP tools are often appropriate.

REMEMBER: This output will be parsed directly as JSON. If the format is incorrect, the operation will fail.
`;

export const toolSelectionArgumentTemplate = `
{{recentMessages}}

# TASK: Generate a Strictly Valid JSON Object for Tool Execution

You have chosen the "{{toolSelectionName.toolName}}" tool from the "{{toolSelectionName.serverName}}" server to address the user's request.
The reasoning behind this selection is: "{{toolSelectionName.reasoning}}"

## CRITICAL INSTRUCTIONS
1. Ensure the "toolArguments" object strictly adheres to the structure and requirements defined in the schema.
2. All parameter values must be extracted from the conversation context and must be concrete, usable values.
3. Avoid placeholders or generic terms unless explicitly provided by the user.

!!! YOUR RESPONSE MUST BE A VALID JSON OBJECT ONLY !!! 

## STRICT FORMAT REQUIREMENTS
- The response MUST be a single valid JSON object.
- DO NOT wrap the JSON in triple backticks (\`\`\`), code blocks, or include any explanatory text.
- DO NOT include comments (// or /* */) anywhere.
- DO NOT use placeholders (e.g., "replace with...", "example", "your...", etc.)
- ALL strings must use double quotes

## CRITICAL NOTES
- All values must be fully grounded in user input or inferred contextually.
- No missing fields unless they are explicitly optional in the schema.
- All types must match the schema (strings, numbers, booleans).

## JSON OBJECT STRUCTURE
Your response MUST contain ONLY these two top-level keys:
1. "toolArguments" — An object matching the input schema: {{toolInputSchema}}
2. "reasoning" — A string explaining how the values were inferred from the conversation.

## EXAMPLE RESPONSE
{
  "toolArguments": {
    "owner": "facebook",
    "repo": "react",
    "path": "README.md",
    "branch": "main"
  },
  "reasoning": "The user wants to see the README from the facebook/react repository based on our conversation."
}

REMEMBER: Your response will be parsed directly as JSON. If it fails to parse, the operation will fail completely.
`;
