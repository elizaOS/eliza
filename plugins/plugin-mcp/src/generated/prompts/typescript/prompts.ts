/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ../../../../prompts/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

export const errorAnalysisTemplate = `{{{mcpProvider.text}}}

{{{recentMessages}}}

# Prompt

You're an assistant helping a user, but there was an error accessing the resource you tried to use.

User request: "{{{userMessage}}}"
Error message: {{{error}}}

Create a helpful response that:
1. Acknowledges the issue in user-friendly terms
2. Offers alternative approaches to help if possible
3. Doesn't expose technical error details unless they're truly helpful
4. Maintains a helpful, conversational tone

Your response:`;

export const ERROR_ANALYSIS_TEMPLATE = errorAnalysisTemplate;

export const feedbackTemplate = `{{{mcpProvider.text}}}

{{{recentMessages}}}

# Prompt

Your previous selection could not be parsed or validated. Correct it as compact JSON.

PREVIOUS RESPONSE:
{{{originalResponse}}

ERROR:
{{{errorMessage}}

Available {{{itemType}}}s:
{{{itemsDescription}}

User request: "{{{userMessage}}}"

CORRECTED INSTRUCTIONS:
1. Select the most appropriate {{{itemType}}} for the task
2. Return one valid JSON object with exact field names and concrete values
3. Ensure all values exactly match the available {{{itemType}}}s (names are case-sensitive!)
4. Do not include markdown fences, comments, tags, or explanatory text outside the JSON
5. Do not use placeholders - all values should be concrete and usable
6. If no appropriate item exists, use "noToolAvailable": true for tools or "noResourceAvailable": true for resources

For tools, use this shape:
{
  "serverName": "exact-server-name",
  "toolName": "exact-tool-name",
  "reasoning": "short reason",
  "noToolAvailable": false
}

For resources, use this shape:
{
  "serverName": "exact-server-name",
  "uri": "exact-resource-uri",
  "reasoning": "short reason",
  "noResourceAvailable": false
}

YOUR CORRECTED JSON RESPONSE:`;

export const FEEDBACK_TEMPLATE = feedbackTemplate;

export const resourceAnalysisTemplate = `{{{mcpProvider.text}}}

{{{recentMessages}}}

# Prompt

You are a helpful assistant responding to a user's request. You've just accessed the resource "{{{uri}}}" to help answer this request.

Original user request: "{{{userMessage}}}"

Resource metadata: 
{{{resourceMeta}}

Resource content: 
{{{resourceContent}}

Instructions:
1. Analyze how well the resource's content addresses the user's specific question or need
2. Identify the most relevant information from the resource
3. Create a natural, conversational response that incorporates this information
4. If the resource content is insufficient, acknowledge its limitations and explain what you can determine
5. Do not start with phrases like "According to the resource" or "Here's what I found" - instead, integrate the information naturally
6. Maintain your helpful, intelligent assistant personality while presenting the information

Your response (written as if directly to the user):`;

export const RESOURCE_ANALYSIS_TEMPLATE = resourceAnalysisTemplate;

export const resourceSelectionTemplate = `{{{mcpProvider.text}}}

{{{recentMessages}}}

# Prompt

You are an intelligent assistant helping select the right resource to address a user's request.

CRITICAL INSTRUCTIONS:
1. You MUST specify both a valid serverName AND uri from the list above
2. The serverName value should match EXACTLY the server name shown in parentheses (Server: X)
   CORRECT: serverName: github (if the server is called "github")
   WRONG: serverName: GitHub, serverName: Github, or any other variation
3. The uri value should match EXACTLY the resource uri listed
   CORRECT: uri: weather://San Francisco/current (if that's the exact uri)
   WRONG: uri: weather://sanfrancisco/current or any variation
4. Identify the user's information need from the conversation context
5. Select the most appropriate resource based on its description and the request
6. If no resource seems appropriate, set noResourceAvailable: true

Respond with compact JSON only.

STRICT FORMAT REQUIREMENTS:
- Include "noResourceAvailable": false when selecting a resource
- NO code block formatting (NO backticks)
- NO comments
- NO placeholders like "replace with...", "example", "your...", "actual", etc.
- Every parameter value must be a concrete, usable value (not instructions to replace)
- NO explanatory text before or after the JSON object

EXAMPLE RESPONSE:
{
  "serverName": "weather-server",
  "uri": "weather://San Francisco/current",
  "reasoning": "The user is asking about current weather in San Francisco. This resource provides up-to-date weather information for that city.",
  "noResourceAvailable": false
}

NO RESOURCE EXAMPLE:
{
  "reasoning": "None of the available resources match the user's request.",
  "noResourceAvailable": true
}`;

export const RESOURCE_SELECTION_TEMPLATE = resourceSelectionTemplate;

export const toolReasoningTemplate = `{{{mcpProvider.text}}}

{{{recentMessages}}}

# Prompt

You are a helpful assistant responding to a user's request. You've just used the "{{{toolName}}}" tool from the "{{{serverName}}}" server to help answer this request.

Original user request: "{{{userMessage}}}"

Tool response:
{{{toolOutput}}}

{{#if hasAttachments}}
The tool also returned images or other media that will be shared with the user.
{{/if}}

Instructions:
1. Analyze how well the tool's response addresses the user's specific question or need
2. Identify the most relevant information from the tool's output
3. Create a natural, conversational response that incorporates this information
4. If the tool's response is insufficient, acknowledge its limitations and explain what you can determine
5. Do not start with phrases like "I used the X tool" or "Here's what I found" - instead, integrate the information naturally
6. Maintain your helpful, intelligent assistant personality while presenting the information

Your response (written as if directly to the user):`;

export const TOOL_REASONING_TEMPLATE = toolReasoningTemplate;

export const toolSelectionArgumentTemplate = `{{recentMessages}}

# TASK: Generate Tool Arguments for Tool Execution

You have chosen the "{{toolSelectionName.toolName}}" tool from the "{{toolSelectionName.serverName}}" server to address the user's request.
The reasoning behind this selection is: "{{toolSelectionName.reasoning}}"

## CRITICAL INSTRUCTIONS
1. Ensure the toolArguments block strictly adheres to the structure and requirements defined in the schema.
2. All parameter values must be extracted from the conversation context and must be concrete, usable values.
3. Avoid placeholders or generic terms unless explicitly provided by the user.

Respond with compact JSON only.

## STRICT FORMAT REQUIREMENTS
- The response MUST be one JSON object.
- DO NOT wrap it in triple backticks, code blocks, or include any explanatory text.
- DO NOT include comments anywhere.
- DO NOT use placeholders (e.g., "replace with...", "example", "your...", etc.)

## CRITICAL NOTES
- All values must be fully grounded in user input or inferred contextually.
- No missing fields unless they are explicitly optional in the schema.
- All types must match the schema (strings, numbers, booleans).
- Put all executable parameters under the toolArguments object.

## RESPONSE STRUCTURE
Your response MUST contain ONLY these two top-level keys:
1. toolArguments - object with fields matching the input schema: {{toolInputSchema}}
2. reasoning - a short explanation of how the values were inferred from the conversation.

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

If the tool takes no arguments, use an empty toolArguments object:
{
  "toolArguments": {},
  "reasoning": "The selected tool does not require arguments for this request."
}`;

export const TOOL_SELECTION_ARGUMENT_TEMPLATE = toolSelectionArgumentTemplate;

export const toolSelectionNameTemplate = `{{mcpProvider.text}}

{{recentMessages}}

# TASK: Select the Most Appropriate Tool and Server

You must select the most appropriate tool from the list above to fulfill the user's request. Respond with compact JSON.

## CRITICAL INSTRUCTIONS
1. Provide both serverName and toolName from the options listed above.
2. Each name must match EXACTLY as shown in the list:
   - Example (correct): serverName: github
   - Example (incorrect): serverName: GitHub, serverName: Github, or variations
3. Extract ACTUAL parameter values from the conversation context.
   - Do not invent or use placeholders like "octocat" or "Hello-World" unless the user said so.
4. Include a reasoning field explaining why the selected tool fits the request.
5. If no tool is appropriate, set noToolAvailable: true.

## STRICT FORMAT REQUIREMENTS
- The response MUST be one JSON object.
- DO NOT wrap it in triple backticks, code blocks, or include any explanatory text.
- DO NOT include comments anywhere.
- DO NOT use placeholders (e.g., "replace with...", "example", "your...", etc.)

## CRITICAL NOTES
- All values must be fully grounded in user input or inferred contextually.
- No missing fields unless they are explicitly optional in the schema.
- All types must match the schema (strings, numbers, booleans).

## RESPONSE STRUCTURE
Your response MUST contain ONLY these top-level keys:
1. serverName - The name of the server (e.g., github, notion)
2. toolName - The name of the tool (e.g., get_file_contents, search)
3. reasoning - A short explanation of how the values were inferred from the conversation
4. noToolAvailable - true or false

## EXAMPLE RESPONSE
{
  "serverName": "github",
  "toolName": "get_file_contents",
  "reasoning": "The user wants to retrieve the README from the facebook/react repository.",
  "noToolAvailable": false
}

## NO TOOL EXAMPLE
{
  "reasoning": "None of the available tools match the user's request.",
  "noToolAvailable": true
}

## REMINDERS
- Use "github" as serverName for GitHub tools.
- Use "notion" as serverName for Notion tools.
- For search and knowledge-based tasks, MCP tools are often appropriate.`;

export const TOOL_SELECTION_NAME_TEMPLATE = toolSelectionNameTemplate;
