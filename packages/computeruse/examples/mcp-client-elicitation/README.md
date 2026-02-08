# MCP Client with Elicitation Support

A simple CLI MCP client that demonstrates elicitation handling.

## Setup

```bash
npm install
```

## Usage

### stdio mode (spawns computeruse-mcp-agent)

```bash
npm run start:stdio
```

This will:
1. Spawn `computeruse-mcp-agent` via npx as a child process
2. Connect via stdio transport
3. List available tools
4. Let you call tools interactively

To use a local build instead of the npm package:
```bash
LOCAL_BUILD=1 npm run start:stdio
```

### HTTP mode (connects to running server)

```bash
npm run start:http [port]
```

Connects to a computeruse-mcp-agent running in HTTP mode (default port: 8080).

### When elicitation is triggered

When the server sends an `elicitation/create` request, the client will:
1. Display the message and schema
2. Prompt you to fill in each field
3. Let you accept, decline, or cancel
4. Send the response back to the server

## Current Status

**Note**: As of Dec 2025, the computeruse-mcp-agent has elicitation *support* but
no tools currently *trigger* elicitation. This client is ready for when tools
start using `peer.elicit()`.

To test elicitation, you would need to:
1. Modify a tool in `computeruse-mcp-agent` to call `elicit_with_fallback()`
2. Or create a test tool that triggers elicitation

## Example Elicitation Flow

```
============================================================
ELICITATION REQUEST
============================================================

Message: What is the business purpose of this workflow?

Please fill in the following fields (or type 'cancel' to cancel, 'decline' to decline):

  What is the business purpose of this automation?: Automate invoice processing
  Target application name (optional): Excel
  Expected outcome or success criteria (optional): All invoices processed

----------------------------------------
Collected data: {
  "business_purpose": "Automate invoice processing",
  "target_app": "Excel",
  "expected_outcome": "All invoices processed"
}

Submit this data? (yes/no): yes
```
