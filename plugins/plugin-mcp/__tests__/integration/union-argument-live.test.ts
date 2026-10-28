/**
 * Opt-in live lane for a mixed MCP union argument (`Optional[Union[str, int]]`).
 *
 * The chain is real end to end: a stdio MCP server, the plugin's own converter,
 * core's tool-schema builder, a chat-completions provider, and the server's
 * reply. Run it with a provider the way `packages/scripts/test-env.ts
 * --lane=post-merge` configures one:
 *
 *   ELIZA_MCP_LIVE_MODEL=1 OPENAI_BASE_URL=... OPENAI_API_KEY=... \
 *     OPENAI_MODEL=<exact-model-id> \
 *     node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts \
 *     __tests__/integration/union-argument-live.test.ts
 *
 * It stays skipped without ELIZA_MCP_LIVE_MODEL=1 so the unit lane needs no key.
 */
import { fileURLToPath } from "node:url";
import { actionToJsonSchema } from "@elizaos/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  convertJsonSchemaToActionParams,
  validateParamsAgainstSchema,
} from "../../src/protocol-utils/schema-converter";

const live = process.env.ELIZA_MCP_LIVE_MODEL === "1";
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const apiKey = process.env.OPENAI_API_KEY ?? "";
const model = process.env.OPENAI_MODEL ?? "";
const fixture = fileURLToPath(new URL("../fixtures/union-argument-server.mjs", import.meta.url));

describe.skipIf(!live)("mixed union argument live lane", () => {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let tool: { name: string; description?: string; inputSchema: Record<string, unknown> };

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixture],
      stderr: "pipe",
    });
    client = new Client({ name: "union-live-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    const found = listed.tools.find((entry) => entry.name === "search_notes");
    if (!found) throw new Error("fixture server did not list search_notes");
    tool = found as typeof tool;
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    transport?.close().catch(() => {});
  });

  it("hands the model a callable schema and runs its call on the server", async () => {
    const parameters = convertJsonSchemaToActionParams(tool.inputSchema as never);
    const parametersSchema = actionToJsonSchema({
      name: "MCP_SEARCH_NOTES",
      description: tool.description ?? "Search notes",
      parameters,
    } as never);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content:
              'Call MCP_SEARCH_NOTES with query "invoice" and limit 3. Use the tool; do not answer in prose.',
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "MCP_SEARCH_NOTES",
              description: tool.description ?? "Search notes",
              parameters: parametersSchema,
            },
          },
        ],
        tool_choice: "auto",
      }),
    });
    const body = (await response.json()) as {
      model?: string;
      choices?: Array<{
        message?: { tool_calls?: Array<{ function: { name: string; arguments: string } }> };
      }>;
    };
    const call = body.choices?.[0]?.message?.tool_calls?.[0];
    expect(
      call,
      `provider ${baseUrl} model ${body.model ?? model} returned no tool call: ${JSON.stringify(body).slice(0, 400)}`
    ).toBeDefined();

    const args = JSON.parse(call?.function.arguments ?? "{}") as Record<string, unknown>;
    expect(validateParamsAgainstSchema(args, tool.inputSchema as never)).toEqual([]);

    const result = await client?.callTool({ name: "search_notes", arguments: args });
    const text = (result?.content as Array<{ type: string; text?: string }> | undefined)
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");

    console.log(
      [
        `provider: ${baseUrl}`,
        `model: ${body.model ?? model}`,
        `declared parameters: ${JSON.stringify(parameters)}`,
        `model arguments: ${JSON.stringify(args)}`,
        `server reply: ${text}`,
      ].join("\n")
    );
    expect(text).toContain("searched:");
  }, 120_000);
});
