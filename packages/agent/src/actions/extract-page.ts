import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { hasOwnerAccess } from "../security/access.js";
import {
  extractHostedCloudPage,
  isHostedCloudToolingConfigured,
} from "../services/hosted-tools.js";

type ExtractPageParameters = {
  formats?: Array<"html" | "links" | "markdown" | "screenshot">;
  onlyMainContent?: boolean;
  timeoutMs?: number;
  url?: string;
  waitFor?: number;
};

function getMessageText(message: Memory | undefined): string {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  return typeof content?.text === "string" ? content.text : "";
}

function extractFirstUrl(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s<>"'`]+/i);
  return match?.[0] ?? null;
}

function formatExtractPreview(
  markdown: string | null,
  html: string | null,
): string {
  const source = markdown?.trim() || html?.trim() || "";
  if (!source) {
    return "No page content was returned.";
  }
  return source.slice(0, 1_500);
}

export const extractPageAction: Action = {
  name: "EXTRACT_PAGE",
  contexts: ["web", "browser", "knowledge"],
  roleGate: { minRole: "ADMIN" },
  similes: ["SCRAPE_PAGE", "FETCH_PAGE", "READ_WEB_PAGE", "EXTRACT_WEB_PAGE"],
  description:
    "Extract page content through Eliza Cloud hosted tools. Returns cleaned markdown plus optional HTML, links, screenshot data, and page metadata.",
  descriptionCompressed:
    "extract page content through Eliza Cloud host tool return clean markdown plus optional HTML, link, screenshot data, page metadata",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return false;
    }
    return isHostedCloudToolingConfigured(process.env);
  },
  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may extract pages.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "EXTRACT_PAGE" },
      };
    }

    if (!isHostedCloudToolingConfigured(process.env)) {
      return {
        text: "Page extraction requires Eliza Cloud hosted tools to be configured.",
        success: false,
        values: { success: false, error: "CLOUD_TOOLS_NOT_CONFIGURED" },
        data: { actionName: "EXTRACT_PAGE" },
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters as
      | ExtractPageParameters
      | undefined;
    const messageText = getMessageText(message);
    const url = params?.url?.trim() || extractFirstUrl(messageText) || "";

    if (!url) {
      return {
        text: "Please provide a page URL to extract.",
        success: false,
        values: { success: false, error: "EMPTY_URL" },
        data: { actionName: "EXTRACT_PAGE" },
      };
    }

    try {
      logger.info(`[extract-page] Hosted extract: "${url}"`);
      const result = await extractHostedCloudPage({
        formats: params?.formats,
        onlyMainContent: params?.onlyMainContent,
        timeoutMs: params?.timeoutMs,
        url,
        waitFor: params?.waitFor,
      });

      return {
        text: `Extracted ${result.url}\n\n${formatExtractPreview(result.markdown, result.html)}`,
        success: true,
        values: {
          success: true,
          linkCount: result.links.length,
          provider: result.provider,
        },
        data: {
          actionName: "EXTRACT_PAGE",
          ...result,
        },
      };
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Hosted extraction failed";
      logger.warn(`[extract-page] Hosted extract failed: ${messageText}`);
      return {
        text: `Page extraction failed: ${messageText}`,
        success: false,
        values: { success: false, error: "EXTRACT_FAILED" },
        data: { actionName: "EXTRACT_PAGE", url },
      };
    }
  },
  parameters: [
    {
      name: "url",
      description: "Page URL to extract",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "formats",
      description: "Requested output formats",
      required: false,
      schema: {
        type: "array" as const,
        items: {
          type: "string" as const,
          enum: ["html", "links", "markdown", "screenshot"],
        },
      },
    },
    {
      name: "onlyMainContent",
      description: "Prefer primary page content only",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "waitFor",
      description: "Wait before extracting, in milliseconds",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "timeoutMs",
      description: "Maximum extraction timeout in milliseconds",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Pull the main content from https://example.com/blog/post-42 for me.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Extracted https://example.com/blog/post-42\n\n# Post 42 — a short summary of the article body.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Give me the text off this docs page: https://docs.elizaos.ai/guide",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Extracted https://docs.elizaos.ai/guide\n\n# Guide — intro paragraph and first section.",
        },
      },
    ],
  ] as ActionExample[][],
};
