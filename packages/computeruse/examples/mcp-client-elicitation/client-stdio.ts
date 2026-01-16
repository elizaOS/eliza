/**
 * MCP Client with Elicitation Support (stdio mode)
 *
 * This example connects to computeruse-mcp-agent via stdio and demonstrates
 * how to handle elicitation requests from the server.
 *
 * Usage:
 *   npm install
 *   npm run start:stdio
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as readline from "readline";

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Render a form based on JSON schema and collect user input
async function renderElicitationForm(
  message: string,
  schema: Record<string, any>
): Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, any> }> {
  console.log("\n" + "=".repeat(60));
  console.log("ELICITATION REQUEST");
  console.log("=".repeat(60));
  console.log("\nMessage: " + message + "\n");

  const properties = schema.properties || {};
  const required = schema.required || [];
  const result: Record<string, any> = {};

  console.log("Please fill in the following fields (or type 'cancel' to cancel, 'decline' to decline):\n");

  for (const [key, prop] of Object.entries(properties) as [string, any][]) {
    const isRequired = required.includes(key);
    const description = prop.description || key;
    const typeHint = prop.type || "string";
    const enumValues = prop.enum;

    let promptText = "  " + description;
    if (enumValues) {
      promptText += " [" + enumValues.join(" | ") + "]";
    }
    if (!isRequired) {
      promptText += " (optional)";
    }
    promptText += ": ";

    const answer = await prompt(promptText);

    if (answer.toLowerCase() === "cancel") {
      return { action: "cancel" };
    }
    if (answer.toLowerCase() === "decline") {
      return { action: "decline" };
    }

    if (answer.trim() !== "" || isRequired) {
      // Type coercion based on schema
      if (typeHint === "number" || typeHint === "integer") {
        result[key] = Number(answer);
      } else if (typeHint === "boolean") {
        result[key] = answer.toLowerCase() === "true" || answer === "1";
      } else {
        result[key] = answer;
      }
    }
  }

  console.log("\n" + "-".repeat(40));
  console.log("Collected data:", JSON.stringify(result, null, 2));

  const confirm = await prompt("\nSubmit this data? (yes/no): ");
  if (confirm.toLowerCase() !== "yes" && confirm.toLowerCase() !== "y") {
    return { action: "decline" };
  }

  return { action: "accept", content: result };
}

async function main() {
  console.log("MCP Client with Elicitation Support");
  console.log("====================================\n");

  // Spawn computeruse-mcp-agent as a child process
  // Use local build if LOCAL_BUILD env is set, otherwise use npx
  const useLocalBuild = process.env.LOCAL_BUILD === "1";
  const transport = new StdioClientTransport(
    useLocalBuild
      ? { command: "../../target/release/computeruse-mcp-agent.exe", args: [] }
      : { command: "npx", args: ["computeruse-mcp-agent"] }
  );

  const client = new Client(
    {
      name: "elicitation-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {
        // Declare that we support elicitation
        elicitation: {},
      },
    }
  );

  // Set up elicitation handler
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    console.log("\n[Received elicitation request]");

    const params = request.params;

    // Only support form mode (URL mode requires browser)
    if (params.mode === "url") {
      console.log("URL mode elicitation not supported in CLI");
      return { action: "decline" as const };
    }

    // Form mode (default when mode is undefined or "form")
    const { message, requestedSchema } = params as { message: string; requestedSchema: Record<string, any> };
    const result = await renderElicitationForm(message, requestedSchema);

    return result;
  });

  try {
    console.log("Connecting to computeruse-mcp-agent...");
    await client.connect(transport);
    console.log("Connected!\n");

    // List available tools
    const tools = await client.listTools();
    console.log("Available tools: " + tools.tools.length);
    console.log(tools.tools.map((t) => "  - " + t.name).join("\n"));
    console.log();

    // Interactive loop
    while (true) {
      const input = await prompt("\nEnter tool name to call (or 'quit' to exit): ");

      if (input.toLowerCase() === "quit" || input.toLowerCase() === "exit") {
        break;
      }

      const tool = tools.tools.find((t) => t.name === input);
      if (!tool) {
        console.log("Tool '" + input + "' not found.");
        continue;
      }

      // Collect tool arguments
      console.log("\nTool: " + tool.name);
      console.log("Description: " + tool.description);

      const args: Record<string, any> = {};
      const inputSchema = tool.inputSchema as any;

      if (inputSchema?.properties) {
        console.log("\nEnter arguments:");
        for (const [key, prop] of Object.entries(inputSchema.properties) as [string, any][]) {
          const answer = await prompt("  " + key + " (" + (prop.description || prop.type) + "): ");
          if (answer.trim()) {
            args[key] = answer;
          }
        }
      }

      console.log("\nCalling tool...");
      try {
        const result = await client.callTool({ name: tool.name, arguments: args });
        console.log("\nResult:", JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error("Tool call failed:", err.message);
      }
    }
  } catch (err: any) {
    console.error("Error:", err.message);
  } finally {
    rl.close();
    await client.close();
    console.log("\nDisconnected.");
  }
}

main().catch(console.error);
