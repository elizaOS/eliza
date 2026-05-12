/**
 * Test client for elizaOS MCP Server
 *
 * Connects to the MCP server and tests the chat and get_agent_info tools.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function childEnv(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    ...extra,
  };
}

async function main(): Promise<void> {
  console.log("🧪 Testing elizaOS MCP Server\n");

  const dataDir = await mkdtemp(join(tmpdir(), "eliza-mcp-example-"));

  // Create client transport
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "server.ts"],
    cwd: import.meta.dirname,
    env: childEnv({ PGLITE_DATA_DIR: dataDir }),
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    console.log("✅ Connected to MCP server\n");

    // Test 1: List tools
    console.log("📋 Listing available tools...");
    const toolsResult = await client.listTools();
    console.log(`   Found ${toolsResult.tools.length} tools:`);
    for (const tool of toolsResult.tools) {
      console.log(`   - ${tool.name}: ${tool.description}`);
    }
    console.log();

    // Test 2: Get agent info
    console.log("ℹ️  Getting agent info...");
    const infoResult = await client.callTool({
      name: "get_agent_info",
      arguments: {},
    });
    const infoContent = infoResult.content as Array<{
      type: string;
      text?: string;
    }>;
    if (infoContent[0]?.type === "text" && infoContent[0].text) {
      const info = JSON.parse(infoContent[0].text);
      console.log(`   Name: ${info.name}`);
      console.log(`   Bio: ${info.bio}`);
      console.log(`   Capabilities: ${info.capabilities.join(", ")}`);
    }
    console.log();

    // Test 3: Chat with agent
    console.log("💬 Testing chat...");
    const testMessages = [
      "Hello! What's your name?",
      "What can you help me with?",
    ];

    for (const message of testMessages) {
      console.log(`   User: ${message}`);
      const chatResult = await client.callTool({
        name: "chat",
        arguments: { message },
      });
      const chatContent = chatResult.content as Array<{
        type: string;
        text?: string;
      }>;
      const responseText = chatContent[0]?.text ?? "";
      if (chatResult.isError || responseText.startsWith("Error:")) {
        throw new Error(responseText || "MCP chat tool returned an error");
      }
      if (chatContent[0]?.type === "text" && responseText) {
        console.log(`   Agent: ${responseText}`);
      }
      console.log();
    }

    console.log("✅ All tests passed!");
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  } finally {
    await transport.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main();
