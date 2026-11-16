/**
 * A model provider's tool-schema rewrite (src/tool-compatibility) moves the
 * keywords that provider does not accept into descriptions of the schema shown
 * in the argument prompt. The MCP action must still check the model's
 * arguments against the schema the server published before it calls the tool.
 * Real SQLite runtime, the registered MCP action and a real stdio MCP server
 * (fixtures/schema-dialect-server.mjs, tool "explicit": a [string, integer]
 * pair with minItems/maxItems 2 and additionalProperties false).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ChannelType, type Memory, ModelType } from "@elizaos/core";
import { createPerfectResultPlugin } from "@elizaos/testing/models";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import { recentMessagesProvider } from "../../plugin-assistant/src/features/basic-capabilities/providers/recentMessages";
import mcpPlugin from "../src/index";
import type { McpService } from "../src/service";

const server = fileURLToPath(new URL("./fixtures/schema-dialect-server.mjs", import.meta.url));
const ARGUMENT_PROMPT = "# TASK: Generate Tool Arguments for Tool Execution";
const RETRIES = 3;

type Provider = "none" | "anthropic" | "google";
type Arguments = "valid" | "short" | "extra";
/** One model case: what the server receives and what the prompt shows. */
type ModelCase = {
  provider: Provider;
  arguments: Arguments;
  attempts: number;
  sent: boolean;
  hidden: string[];
};

const TOOL_ARGUMENTS: Record<Arguments, Record<string, unknown>> = {
  valid: { pair: ["task", 0] },
  // Breaks minItems: 2 only (items: false still allows one prefix item).
  short: { pair: ["task"] },
  // Breaks additionalProperties: false only.
  extra: { pair: ["task", 0], extra: "x" },
};
// Keywords of the server's schema that a rewrite may take out of the prompt.
const CONSTRAINTS = ["additionalProperties", "maxItems", "minItems"] as const;
// The description text each rewrite writes for a keyword it takes out.
const RESTATED: Record<Provider, Partial<Record<(typeof CONSTRAINTS)[number], string>>> = {
  none: {},
  anthropic: { additionalProperties: "Only use the specified properties" },
  google: {
    additionalProperties: "no additional properties allowed",
    maxItems: "array must contain no more than 2 items",
    minItems: "array must contain at least 2 items",
  },
};

function expected(provider: Provider, args: Arguments): ModelCase {
  const sent = args === "valid";
  return {
    provider,
    arguments: args,
    attempts: sent ? 1 : RETRIES,
    sent,
    hidden: Object.keys(RESTATED[provider]).sort(),
  };
}

// Without the model's env variable, every group replays all of its cases.
const DEFAULT_CASES: ModelCase[] = (["none", "anthropic", "google"] as const).flatMap((provider) =>
  (["valid", "short", "extra"] as const).map((args) => expected(provider, args))
);
const MODEL_CASES: ModelCase[] = process.env.ELIZA_MCP_ARGUMENT_COMPATIBILITY_MODEL_CASES
  ? JSON.parse(readFileSync(process.env.ELIZA_MCP_ARGUMENT_COMPATIBILITY_MODEL_CASES, "utf8"))
  : DEFAULT_CASES;

/** Run the MCP call_tool action once and read what the server received. */
async function callExplicit(provider: Provider, args: Arguments) {
  const prompts: string[] = [];
  const model = createPerfectResultPlugin({
    fixtures: [
      {
        name: "argument-selection",
        match: { modelType: ModelType.TEXT_LARGE },
        times: { min: 1, max: RETRIES },
        response: (call) => {
          prompts.push(call.params.prompt ?? "");
          return JSON.stringify({ toolArguments: TOOL_ARGUMENTS[args] });
        },
      },
      {
        name: "tool-response",
        match: { modelType: ModelType.TEXT_SMALL },
        times: { min: 0, max: 1 },
        response: () => "The tool received the pair.",
      },
    ],
  });
  const runtime = createSQLiteTestRuntime({
    character: {
      name: `mcp-argument-compatibility-${provider}`,
      bio: ["Call MCP tools with arguments the server's schema accepts"],
      settings: {
        ...(provider === "none" ? {} : { MODEL_PROVIDER: provider }),
        mcp: { servers: { peer: { type: "stdio", command: "node", args: [server] } } },
      },
    },
    plugins: [mcpPlugin, model],
    logLevel: "fatal",
  });
  try {
    await runtime.initialize();
    runtime.registerProvider(recentMessagesProvider);
    const service = (await runtime.getServiceLoadPromise("mcp")) as McpService;
    expect(service.getServers()[0].status).toBe("connected");
    const roomId = randomUUID(),
      entityId = randomUUID(),
      worldId = randomUUID();
    await runtime.ensureConnection({
      roomId,
      entityId,
      worldId,
      source: "mcp-argument-compatibility",
      type: ChannelType.DM,
    });
    const message: Memory = {
      id: randomUUID(),
      roomId,
      entityId,
      worldId,
      agentId: runtime.agentId,
      content: {
        text: `Use explicit on peer with ${JSON.stringify(TOOL_ARGUMENTS[args])}.`,
        source: "mcp-argument-compatibility",
      },
    };
    await runtime.createMemory(message, "messages");
    const action = runtime.actions.find((entry) => entry.name === "MCP");
    if (!action?.handler) throw new Error("Registered MCP action is missing");
    const result = await action.handler(
      runtime,
      message,
      undefined,
      { parameters: { op: "call_tool", serverName: "peer", toolName: "explicit" } },
      async () => []
    );
    if (!result || typeof result !== "object") throw new Error("Expected action result");
    const receipt = (await service.readResource("peer", "fixture:///calls")).contents[0];
    if (typeof receipt.text !== "string") throw new Error("Expected invocation receipt");
    const invocations = JSON.parse(receipt.text) as Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>;
    model.assertFixturesConsumed();
    return { result, invocations, prompts };
  } finally {
    await runtime.stop();
  }
}

/** Compare one real call with its model case. */
async function replay(item: ModelCase) {
  const { result, invocations, prompts } = await callExplicit(item.provider, item.arguments);
  expect(prompts.length).toBeGreaterThan(0);
  expect(prompts.every((prompt) => prompt.includes(ARGUMENT_PROMPT))).toBe(true);
  // The first prompt carries the schema the model saw, before any validation
  // feedback is appended.
  const hidden = CONSTRAINTS.filter((key) => !prompts[0].includes(`"${key}"`));
  for (const key of hidden) {
    expect(prompts[0], `${item.provider} restates ${key}`).toContain(RESTATED[item.provider][key]);
  }
  expect(
    {
      provider: item.provider,
      arguments: item.arguments,
      attempts: prompts.length,
      sent: invocations.length > 0,
      hidden: [...hidden].sort(),
    },
    `${item.provider}/${item.arguments}`
  ).toEqual(item);
  expect(invocations).toEqual(
    item.sent ? [{ name: "explicit", arguments: TOOL_ARGUMENTS[item.arguments] }] : []
  );
  expect(result.values?.toolExecuted === true).toBe(item.sent);
  expect(result.data?.noToolAvailable === true).toBe(!item.sent);
}

describe("MCP arguments keep the server schema under provider rewrites", () => {
  it("refuses a one-item pair under the google rewrite", async () => {
    const { result, invocations, prompts } = await callExplicit("google", "short");

    expect(invocations).toEqual([]);
    expect(result.data?.noToolAvailable).toBe(true);
    expect(prompts).toHaveLength(RETRIES);
    expect(prompts[0]).not.toContain('"minItems"');
    expect(prompts[0]).toContain("array must contain at least 2 items");
  });

  const groups = (["none", "anthropic", "google"] as const).map((provider) => ({
    name: provider === "none" ? "no rewrite" : `the ${provider} rewrite`,
    cases: MODEL_CASES.filter((item) => item.provider === provider),
  }));
  it.each(groups)("argument model replays $name", async ({ cases }) => {
    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) {
      await replay(item);
    }
  });
});
