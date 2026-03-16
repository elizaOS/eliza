//! Auto-generated prompt templates
//! DO NOT EDIT - Generated from ../../../../../prompts/*.txt
//!
//! These prompts use Handlebars-style template syntax:
//! - {{variableName}} for simple substitution
//! - {{#each items}}...{{/each}} for iteration
//! - {{#if condition}}...{{/if}} for conditionals

pub const ERROR_ANALYSIS_TEMPLATE: &str = r#"{{{mcpProvider.text}}}

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

Your response:"#;

pub const FEEDBACK_TEMPLATE: &str = r#"{{{mcpProvider.text}}}

{{{recentMessages}}}

# Prompt

You previously attempted to parse a JSON selection but encountered an error. You need to fix the issues and provide a valid JSON response.

PREVIOUS RESPONSE:
{{{originalResponse}}

ERROR:
{{{errorMessage}}

Available {{{itemType}}}s:
{{{itemsDescription}}

User request: "{{{userMessage}}}"

CORRECTED INSTRUCTIONS:
1. Create a valid JSON object that selects the most appropriate {{{itemType}}} for the task
2. Make sure to use proper JSON syntax with double quotes for keys and string values
3. Ensure all values exactly match the available {{{itemType}}}s (names are case-sensitive!)
4. Do not include any markdown formatting, explanations, or non-JSON content
5. Do not use placeholders - all values should be concrete and usable

YOUR CORRECTED VALID JSON RESPONSE:"#;

pub const RESOURCE_ANALYSIS_TEMPLATE: &str = r#"{{{mcpProvider.text}}}

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

Your response (written as if directly to the user):"#;

pub const RESOURCE_SELECTION_TEMPLATE: &str = r#"{{{mcpProvider.text}}}

{{{recentMessages}}}

# Prompt

You are an intelligent assistant helping select the right resource to address a user's request.

CRITICAL INSTRUCTIONS:
1. You MUST specify both a valid serverName AND uri from the list above
2. The serverName value should match EXACTLY the server name shown in parentheses (Server: X)
   CORRECT: "serverName": "github"  (if the server is called "github") 
   WRONG: "serverName": "GitHub" or "Github" or any other variation
3. The uri value should match EXACTLY the resource uri listed
   CORRECT: "uri": "weather://San Francisco/current"  (if that's the exact uri)
   WRONG: "uri": "weather://sanfrancisco/current" or any variation
4. Identify the user's information need from the conversation context
5. Select the most appropriate resource based on its description and the request
6. If no resource seems appropriate, output {"noResourceAvailable": true}

!!! YOUR RESPONSE MUST BE A VALID JSON OBJECT ONLY !!! 

STRICT FORMAT REQUIREMENTS:
- NO code block formatting (NO backticks or ```)
- NO comments (NO // or /* */)
- NO placeholders like "replace with...", "example", "your...", "actual", etc.
- Every parameter value must be a concrete, usable value (not instructions to replace)
- Use proper JSON syntax with double quotes for strings
- NO explanatory text before or after the JSON object

EXAMPLE RESPONSE:
{
  "serverName": "weather-server",
  "uri": "weather://San Francisco/current",
  "reasoning": "Based on the conversation, the user is asking about current weather in San Francisco. This resource provides up-to-date weather information for that city."
}

REMEMBER: Your response will be parsed directly as JSON. If it fails to parse, the operation will fail completely!"#;

pub const TOOL_REASONING_TEMPLATE: &str = r#"{{{mcpProvider.text}}}

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

Your response (written as if directly to the user):"#;

pub const TOOL_SELECTION_ARGUMENT_TEMPLATE: &str = r#"{{recentMessages}}

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
- DO NOT wrap the JSON in triple backticks (```), code blocks, or include any explanatory text.
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

REMEMBER: Your response will be parsed directly as JSON. If it fails to parse, the operation will fail completely."#;

pub const TOOL_SELECTION_NAME_TEMPLATE: &str = r#"{{mcpProvider.text}}

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
- DO NOT wrap the JSON in triple backticks (```), code blocks, or include any explanatory text.
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

REMEMBER: This output will be parsed directly as JSON. If the format is incorrect, the operation will fail."#;

