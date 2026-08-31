/**
 * Exercises one MCP fixture through the shared kernel and both runtime facades;
 * transport, OAuth, visibility, and persistence are intentionally out of scope.
 */

import { composePromptFromState } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { toolReasoningTemplate as localToolReasoningTemplate } from "../../../../../plugins/plugin-mcp/src/prompts.js";
import { buildMcpProviderData as buildLocalProjection } from "../../../../../plugins/plugin-mcp/src/utils/mcp.js";
import { validateResourceSelection as validateLocalResource } from "../../../../../plugins/plugin-mcp/src/utils/validation.js";
import { buildMcpProviderData as buildCloudProjection } from "../../../../cloud/shared/src/lib/eliza/plugin-mcp/utils/mcp.js";
import { validateResourceSelection as validateCloudResource } from "../../../../cloud/shared/src/lib/eliza/plugin-mcp/utils/validation.js";
import {
  buildMcpProviderProjection,
  detectMcpModelProvider,
  toolReasoningTemplate,
} from "../index.js";

const servers = [
  {
    name: "files",
    status: "connected" as const,
    config: "fixture",
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object" as const,
          properties: { path: { type: "string" as const } },
        },
      },
    ],
    resources: [
      {
        uri: "file:///notes.txt",
        name: "notes",
        description: "Saved notes",
      },
    ],
  },
];

describe("MCP facade conformance", () => {
  it("projects the same complete server fixture through both facades", () => {
    const canonical = buildMcpProviderProjection(servers);
    expect(buildLocalProjection(servers as never)).toEqual(canonical);
    expect(buildCloudProjection(servers as never)).toEqual(canonical);
  });

  it("accepts and rejects the same resource selections", () => {
    for (const selection of [
      { serverName: "files", uri: "file:///notes.txt" },
      { noResourceAvailable: true },
      { serverName: "files" },
      null,
    ]) {
      expect(validateLocalResource(selection)).toEqual(
        validateCloudResource(selection),
      );
    }
  });

  it("detects provider and reasoning policy from projected host metadata", () => {
    expect(
      detectMcpModelProvider({ modelProvider: "openai", model: "o3-mini" }),
    ).toMatchObject({ provider: "openai", isReasoningModel: true });
    expect(detectMcpModelProvider({ model: "gemini-2.0-flash" })).toMatchObject(
      {
        provider: "google",
        supportsStructuredOutputs: true,
      },
    );
  });

  it("keeps the plugin prompt facade on the canonical tool-result template", () => {
    expect(localToolReasoningTemplate).toBe(toolReasoningTemplate);
  });

  it("frames errored tool results as failures without truncating their detail", () => {
    const errorDetail = `Error from <upstream>: ${"complete-detail&".repeat(1_000)}`;
    const prompt = composePromptFromState({
      state: {
        values: {
          mcpProvider: { text: "MCP servers: files" },
          recentMessages: "User: run the tool",
          toolName: "read_file",
          userMessage: "run the tool",
          toolOutput: errorDetail,
          toolErrored: true,
          hasAttachments: false,
        },
      } as never,
      template: toolReasoningTemplate,
    });

    expect(prompt).toContain(errorDetail);
    expect(prompt).toContain("The tool reported an ERROR");
    expect(prompt).toContain("the call did NOT succeed");
    expect(prompt).toContain(
      "do not present the error content as if it were a successful result",
    );
  });

  it("omits failure framing for successful tool results", () => {
    const prompt = composePromptFromState({
      state: {
        values: {
          mcpProvider: { text: "MCP servers: files" },
          recentMessages: "User: run the tool",
          toolName: "read_file",
          userMessage: "run the tool",
          toolOutput: "requested data",
          toolErrored: false,
          hasAttachments: false,
        },
      } as never,
      template: toolReasoningTemplate,
    });

    expect(prompt).toContain("requested data");
    expect(prompt).not.toContain("The tool reported an ERROR");
  });
});
