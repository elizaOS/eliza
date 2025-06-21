Claude Code SDK

Copy page

Learn about programmatically integrating Claude Code into your applications with the Claude Code SDK.

The Claude Code SDK enables running Claude Code as a subprocess, providing a way to build AI-powered coding assistants and tools that leverage Claude’s capabilities.

The SDK is available for command line, TypeScript, and Python usage.

​
Authentication
To use the Claude Code SDK, we recommend creating a dedicated API key:

Create an Anthropic API key in the Anthropic Console
Then, set the ANTHROPIC_API_KEY environment variable. We recommend storing this key securely (eg. using a Github secret)
​
Basic SDK usage
The Claude Code SDK allows you to use Claude Code in non-interactive mode from your applications.

​
Command line
Here are a few basic examples for the command line SDK:

Copy

# Run a single prompt and exit (print mode)

$ claude -p "Write a function to calculate Fibonacci numbers"

# Using a pipe to provide stdin

$ echo "Explain this code" | claude -p

# Output in JSON format with metadata

$ claude -p "Generate a hello world function" --output-format json

# Stream JSON output as it arrives

$ claude -p "Build a React component" --output-format stream-json
​
TypeScript
The TypeScript SDK is included in the main @anthropic-ai/claude-code package on NPM:

Copy
import { query, type SDKMessage } from "@anthropic-ai/claude-code";

const messages: SDKMessage[] = [];

for await (const message of query({
prompt: "Write a haiku about foo.py",
abortController: new AbortController(),
options: {
maxTurns: 3,
},
})) {
messages.push(message);
}

console.log(messages);
The TypeScript SDK accepts all arguments supported by the command line SDK, as well as:

Argument Description Default
abortController Abort controller new AbortController()
cwd Current working directory process.cwd()
executable Which JavaScript runtime to use node when running with Node.js, bun when running with Bun
executableArgs Arguments to pass to the executable []
pathToClaudeCodeExecutable Path to the Claude Code executable Executable that ships with @anthropic-ai/claude-code
​
Python
The Python SDK is available as claude-code-sdk on PyPI:

Copy
pip install claude-code-sdk
Prerequisites:

Python 3.10+
Node.js
Claude Code CLI: npm install -g @anthropic-ai/claude-code
Basic usage:

Copy
import anyio
from claude_code_sdk import query, ClaudeCodeOptions, Message

async def main():
messages: list[Message] = []

    async for message in query(
        prompt="Write a haiku about foo.py",
        options=ClaudeCodeOptions(max_turns=3)
    ):
        messages.append(message)

    print(messages)

anyio.run(main)
The Python SDK accepts all arguments supported by the command line SDK through the ClaudeCodeOptions class:

Copy
from claude_code_sdk import query, ClaudeCodeOptions
from pathlib import Path

options = ClaudeCodeOptions(
max_turns=3,
system_prompt="You are a helpful assistant",
cwd=Path("/path/to/project"), # Can be string or Path
allowed_tools=["Read", "Write", "Bash"],
permission_mode="acceptEdits"
)

async for message in query(prompt="Hello", options=options):
print(message)
​
Advanced usage
The documentation below uses the command line SDK as an example, but can also be used with the TypeScript and Python SDKs.

​
Multi-turn conversations
For multi-turn conversations, you can resume conversations or continue from the most recent session:

Copy

# Continue the most recent conversation

$ claude --continue

# Continue and provide a new prompt

$ claude --continue "Now refactor this for better performance"

# Resume a specific conversation by session ID

$ claude --resume 550e8400-e29b-41d4-a716-446655440000

# Resume in print mode (non-interactive)

$ claude -p --resume 550e8400-e29b-41d4-a716-446655440000 "Update the tests"

# Continue in print mode (non-interactive)

$ claude -p --continue "Add error handling"
​
Custom system prompts
You can provide custom system prompts to guide Claude’s behavior:

Copy

# Override system prompt (only works with --print)

$ claude -p "Build a REST API" --system-prompt "You are a senior backend engineer. Focus on security, performance, and maintainability."

# System prompt with specific requirements

$ claude -p "Create a database schema" --system-prompt "You are a database architect. Use PostgreSQL best practices and include proper indexing."
You can also append instructions to the default system prompt:

Copy

# Append system prompt (only works with --print)

$ claude -p "Build a REST API" --append-system-prompt "After writing code, be sure to code review yourself."
​
MCP Configuration
The Model Context Protocol (MCP) allows you to extend Claude Code with additional tools and resources from external servers. Using the --mcp-config flag, you can load MCP servers that provide specialized capabilities like database access, API integrations, or custom tooling.

Create a JSON configuration file with your MCP servers:

Copy
{
"mcpServers": {
"filesystem": {
"command": "npx",
"args": [
"-y",
"@modelcontextprotocol/server-filesystem",
"/path/to/allowed/files"
]
},
"github": {
"command": "npx",
"args": ["-y", "@modelcontextprotocol/server-github"],
"env": {
"GITHUB_TOKEN": "your-github-token"
}
}
}
}
Then use it with Claude Code:

Copy

# Load MCP servers from configuration

$ claude -p "List all files in the project" --mcp-config mcp-servers.json

# Important: MCP tools must be explicitly allowed using --allowedTools

# MCP tools follow the format: mcp**$serverName**$toolName

$ claude -p "Search for TODO comments" \
 --mcp-config mcp-servers.json \
 --allowedTools "mcp**filesystem**read_file,mcp**filesystem**list_directory"

# Use an MCP tool for handling permission prompts in non-interactive mode

$ claude -p "Deploy the application" \
 --mcp-config mcp-servers.json \
 --allowedTools "mcp**permissions**approve" \
 --permission-prompt-tool mcp**permissions**approve
When using MCP tools, you must explicitly allow them using the --allowedTools flag. MCP tool names follow the pattern mcp**<serverName>**<toolName> where:

serverName is the key from your MCP configuration file
toolName is the specific tool provided by that server
This security measure ensures that MCP tools are only used when explicitly permitted.

If you specify just the server name (i.e., mcp\_\_<serverName>), all tools from that server will be allowed.

Glob patterns (e.g., mcp\_\_go\*) are not supported.

​
Custom permission prompt tool
Optionally, use --permission-prompt-tool to pass in an MCP tool that we will use to check whether or not the user grants the model permissions to invoke a given tool. When the model invokes a tool the following happens:

We first check permission settings: all settings.json files, as well as --allowedTools and --disallowedTools passed into the SDK; if one of these allows or denies the tool call, we proceed with the tool call
Otherwise, we invoke the MCP tool you provided in --permission-prompt-tool
The --permission-prompt-tool MCP tool is passed the tool name and input, and must return a JSON-stringified payload with the result. The payload must be one of:

Copy
// tool call is allowed
{
"behavior": "allow",
"updatedInput": {...}, // updated input, or just return back the original input
}

// tool call is denied
{
"behavior": "deny",
"message": "..." // human-readable string explaining why the permission was denied
}
For example, a TypeScript MCP permission prompt tool implementation might look like this:

Copy
const server = new McpServer({
name: "Test permission prompt MCP Server",
version: "0.0.1",
});

server.tool(
"approval_prompt",
'Simulate a permission check - approve if the input contains "allow", otherwise deny',
{
tool_name: z.string().describe("The tool requesting permission"),
input: z.object({}).passthrough().describe("The input for the tool"),
},
async ({ tool_name, input }) => {
return {
content: [
{
type: "text",
text: JSON.stringify(
JSON.stringify(input).includes("allow")
? {
behavior: "allow",
updatedInput: input,
}
: {
behavior: "deny",
message: "Permission denied by test approval_prompt tool",
}
),
},
],
};
}
);
To use this tool, add your MCP server (eg. with --mcp-config), then invoke the SDK like so:

Copy
claude -p "..." \
 --permission-prompt-tool mcp**test-server**approval_prompt \
 --mcp-config my-config.json
Usage notes:

Use updatedInput to tell the model that the permission prompt mutated its input; otherwise, set updatedInput to the original input, as in the example above. For example, if the tool shows a file edit diff to the user and lets them edit the diff manually, the permission prompt tool should return that updated edit.
The payload must be JSON-stringified
​
Available CLI options
The SDK leverages all the CLI options available in Claude Code. Here are the key ones for SDK usage:

Flag Description Example
--print, -p Run in non-interactive mode claude -p "query"
--output-format Specify output format (text, json, stream-json) claude -p --output-format json
--resume, -r Resume a conversation by session ID claude --resume abc123
--continue, -c Continue the most recent conversation claude --continue
--verbose Enable verbose logging claude --verbose
--max-turns Limit agentic turns in non-interactive mode claude --max-turns 3
--system-prompt Override system prompt (only with --print) claude --system-prompt "Custom instruction"
--append-system-prompt Append to system prompt (only with --print) claude --append-system-prompt "Custom instruction"
--allowedTools Space-separated list of allowed tools, or

string of comma-separated list of allowed tools claude --allowedTools mcp**slack mcp**filesystem

claude --allowedTools "Bash(npm install),mcp\_\_filesystem"
--disallowedTools Space-separated list of denied tools, or

string of comma-separated list of denied tools claude --disallowedTools mcp**splunk mcp**github

claude --disallowedTools "Bash(git commit),mcp**github"
--mcp-config Load MCP servers from a JSON file claude --mcp-config servers.json
--permission-prompt-tool MCP tool for handling permission prompts (only with --print) claude --permission-prompt-tool mcp**auth\_\_prompt
For a complete list of CLI options and features, see the CLI reference documentation.

​
Output formats
The SDK supports multiple output formats:

​
Text output (default)
Returns just the response text:

Copy
$ claude -p "Explain file src/components/Header.tsx"

# Output: This is a React component showing...

​
JSON output
Returns structured data including metadata:

Copy
$ claude -p "How does the data layer work?" --output-format json
Response format:

Copy
{
"type": "result",
"subtype": "success",
"total_cost_usd": 0.003,
"is_error": false,
"duration_ms": 1234,
"duration_api_ms": 800,
"num_turns": 6,
"result": "The response text here...",
"session_id": "abc123"
}
​
Streaming JSON output
Streams each message as it is received:

Copy
$ claude -p "Build an application" --output-format stream-json
Each conversation begins with an initial init system message, followed by a list of user and assistant messages, followed by a final result system message with stats. Each message is emitted as a separate JSON object.

​
Message schema
Messages returned from the JSON API are strictly typed according to the following schema:

Copy
type SDKMessage =
// An assistant message
| {
type: "assistant";
message: Message; // from Anthropic SDK
session_id: string;
}

// A user message
| {
type: "user";
message: MessageParam; // from Anthropic SDK
session_id: string;
}

// Emitted as the last message
| {
type: "result";
subtype: "success";
duration_ms: float;
duration_api_ms: float;
is_error: boolean;
num_turns: int;
result: string;
session_id: string;
total_cost_usd: float;
}

// Emitted as the last message, when we've reached the maximum number of turns
| {
type: "result";
subtype: "error_max_turns" | "error_during_execution";
duration_ms: float;
duration_api_ms: float;
is_error: boolean;
num_turns: int;
session_id: string;
total_cost_usd: float;
}

// Emitted as the first message at the start of a conversation
| {
type: "system";
subtype: "init";
apiKeySource: string;
cwd: string;
session_id: string;
tools: string[];
mcp_servers: {
name: string;
status: string;
}[];
model: string;
permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
};
We will soon publish these types in a JSONSchema-compatible format. We use semantic versioning for the main Claude Code package to communicate breaking changes to this format.

Message and MessageParam types are available in Anthropic SDKs. For example, see the Anthropic TypeScript and Python SDKs.

​
Input formats
The SDK supports multiple input formats:

​
Text input (default)
Input text can be provided as an argument:

Copy
$ claude -p "Explain this code"
Or input text can be piped via stdin:

Copy
$ echo "Explain this code" | claude -p
​
Streaming JSON input
A stream of messages provided via stdin where each message represents a user turn. This allows multiple turns of a conversation without re-launching the claude binary and allows providing guidance to the model while it is processing a request.

Each message is a JSON ‘User message’ object, following the same format as the output message schema. Messages are formatted using the jsonl format where each line of input is a complete JSON object. Streaming JSON input requires -p and --output-format stream-json.

Currently this is limited to text-only user messages.

Copy
$ echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Explain this code"}]}}' | claude -p --output-format=stream-json --input-format=stream-json --verbose
​
Examples
​
Simple script integration

Copy
#!/bin/bash

# Simple function to run Claude and check exit code

run_claude() {
local prompt="$1"
    local output_format="${2:-text}"

    if claude -p "$prompt" --output-format "$output_format"; then
        echo "Success!"
    else
        echo "Error: Claude failed with exit code $?" >&2
        return 1
    fi

}

# Usage examples

run_claude "Write a Python function to read CSV files"
run_claude "Optimize this database query" "json"
​
Processing files with Claude

Copy

# Process a file through Claude

$ cat mycode.py | claude -p "Review this code for bugs"

# Process multiple files

$ for file in \*.js; do
echo "Processing $file..."
    claude -p "Add JSDoc comments to this file:" < "$file" > "${file}.documented"
done

# Use Claude in a pipeline

$ grep -l "TODO" \*.py | while read file; do
claude -p "Fix all TODO items in this file" < "$file"
done
​
Session management

Copy

# Start a session and capture the session ID

$ claude -p "Initialize a new project" --output-format json | jq -r '.session_id' > session.txt

# Continue with the same session

$ claude -p --resume "$(cat session.txt)" "Add unit tests"
​
Best practices
Use JSON output format for programmatic parsing of responses:

Copy

# Parse JSON response with jq

result=$(claude -p "Generate code" --output-format json)
code=$(echo "$result" | jq -r '.result')
cost=$(echo "$result" | jq -r '.cost_usd')
Handle errors gracefully - check exit codes and stderr:

Copy
if ! claude -p "$prompt" 2>error.log; then
echo "Error occurred:" >&2
cat error.log >&2
exit 1
fi
Use session management for maintaining context in multi-turn conversations

Consider timeouts for long-running operations:

Copy
timeout 300 claude -p "$complex_prompt" || echo "Timed out after 5 minutes"
Respect rate limits when making multiple requests by adding delays between calls

​
