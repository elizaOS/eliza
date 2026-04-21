/**
 * Page Content Provider
 *
 * Injects the current webpage content into the agent's context,
 * allowing the agent to answer questions about the page.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { PageContent } from "../types";

// Cache key for storing page content
const PAGE_CONTENT_CACHE_KEY = "currentPageContent";

/**
 * Store page content in the runtime cache
 */
export async function setPageContent(
  runtime: IAgentRuntime,
  content: PageContent | null
): Promise<void> {
  await runtime.setCache(PAGE_CONTENT_CACHE_KEY, content);
}

/**
 * Get page content from the runtime cache
 */
export async function getPageContent(
  runtime: IAgentRuntime
): Promise<PageContent | null> {
  return (await runtime.getCache(PAGE_CONTENT_CACHE_KEY)) as PageContent | null;
}

/**
 * Page Content Provider
 *
 * This provider injects the current webpage content into the agent's context.
 * The content is stored in the runtime cache by the extension's background script
 * whenever the user navigates to a new page or opens the popup.
 */
export const pageContentProvider: Provider = {
  name: "PAGE_CONTENT",
  description:
    "Current webpage content for contextual chat - allows the agent to answer questions about the page the user is viewing",
  position: 10, // Run early to establish context

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const pageContent = await getPageContent(runtime);

    if (!pageContent) {
      return {
        text: "",
        data: {},
        values: {
          hasPageContent: "false",
        },
      };
    }

    // Truncate content if too long (roughly 4000 tokens worth)
    const maxContentLength = 12000;
    const truncatedContent =
      pageContent.content.length > maxContentLength
        ? pageContent.content.slice(0, maxContentLength) + "\n\n[Content truncated...]"
        : pageContent.content;

    const contextText = `# Current Webpage Context

**Title:** ${pageContent.title}
**URL:** ${pageContent.url}

## Page Content:
${truncatedContent}

---
The user is viewing this webpage and may ask questions about it. Use the content above to provide helpful, accurate answers about what's on the page.`;

    return {
      text: contextText,
      data: {
        pageContent: {
          title: pageContent.title,
          url: pageContent.url,
          contentLength: pageContent.content.length,
          extractedAt: pageContent.extractedAt,
        },
      },
      values: {
        hasPageContent: "true",
        pageTitle: pageContent.title,
        pageUrl: pageContent.url,
      },
    };
  },
};
