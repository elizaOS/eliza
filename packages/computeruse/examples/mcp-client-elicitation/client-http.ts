/**
 * MCP Client with Elicitation Support (HTTP/SSE mode)
 *
 * This example connects to a running computeruse-mcp-agent via HTTP
 * and demonstrates how to handle elicitation requests.
 *
 * Usage:
 *   npm install
 *   npx tsx client-http.ts [port]
 *
 * Default port: 8080
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as readline from "readline";

const PORT = process.argv[2] || "8080";
const MCP_URL = "http://127.0.0.1:" + PORT + "/mcp";

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

  console.log("Fill in fields (type 'cancel' or 'decline' to abort):\n");

  for (const [key, prop] of Object.entries(properties) as [string, any][]) {
    const isRequired = required.includes(key);
    const description = prop.description || key;
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

    if (answer.trim() !== "") {
      result[key] = answer;
    }
  }

  console.log("\nCollected:", JSON.stringify(result, null, 2));

  const confirm = await prompt("\nSubmit? (yes/no): ");
  if (confirm.toLowerCase() !== "yes" && confirm.toLowerCase() !== "y") {
    return { action: "decline" };
  }

  return { action: "accept", content: result };
}

async function main() {
  console.log("MCP Client with Elicitation (HTTP mode)");
  console.log("========================================");
  console.log("Connecting to: " + MCP_URL + "\n");

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));

  const client = new Client(
    {
      name: "elicitation-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {
        elicitation: {},
      },
    }
  );

  // Set up elicitation handler
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    console.log("\n[Elicitation request received]");

    const params = request.params;

    // Only support form mode (URL mode requires browser)
    if (params.mode === "url") {
      console.log("URL mode elicitation not supported in CLI");
      return { action: "decline" as const };
    }

    // Form mode (default when mode is undefined or "form")
    const { message, requestedSchema } = params as { message: string; requestedSchema: Record<string, any> };
    return await renderElicitationForm(message, requestedSchema);
  });

  try {
    await client.connect(transport);
    console.log("Connected!\n");

    // List tools
    const tools = await client.listTools();
    console.log("Tools (" + tools.tools.length + "):");
    tools.tools.slice(0, 10).forEach((t) => console.log("  - " + t.name));
    if (tools.tools.length > 10) {
      console.log("  ... and " + (tools.tools.length - 10) + " more");
    }

    // Interactive loop
    while (true) {
      const input = await prompt("\nTool to call (or 'list', 'quit'): ");

      if (input === "quit" || input === "exit") break;
      if (input === "list") {
        tools.tools.forEach((t) => console.log("  " + t.name));
        continue;
      }

      const tool = tools.tools.find((t) => t.name === input);
      if (!tool) {
        console.log("Not found: " + input);
        continue;
      }

      // Collect args
      const args: Record<string, any> = {};
      const schema = tool.inputSchema as any;

      if (schema?.properties) {
        console.log("\nArguments for " + tool.name + ":");
        for (const [k, v] of Object.entries(schema.properties) as [string, any][]) {
          const required = (schema.required || []).includes(k);
          const ans = await prompt("  " + k + (required ? " (required)" : "") + ": ");
          if (ans.trim()) {
            // Try to parse JSON for complex types
            try {
              args[k] = JSON.parse(ans);
            } catch {
              args[k] = ans;
            }
          }
        }
      }

      console.log("\nCalling " + tool.name + "...");
      try {
        const result = await client.callTool({ name: tool.name, arguments: args });
        console.log("\nResult:");
        console.log(JSON.stringify(result, null, 2).slice(0, 2000));
      } catch (err: any) {
        console.error("Error:", err.message);
      }
    }
  } catch (err: any) {
    console.error("Connection error:", err.message);
  } finally {
    rl.close();
    await client.close();
    console.log("\nBye!");
  }
}

main().catch(console.error);
