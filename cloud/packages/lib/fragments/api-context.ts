/**
 * API Context Builder for Fragments
 *
 * Builds context from API endpoint discovery for inclusion in generation prompts
 */

import { API_ENDPOINTS, type ApiEndpoint } from "@/lib/swagger/endpoint-discovery";

export interface ApiContextOptions {
  categories?: string[];
  tags?: string[];
  limit?: number;
  includeExamples?: boolean;
}

/**
 * Build API documentation context for LLM prompts
 */
export async function buildApiContext(options: ApiContextOptions = {}): Promise<string> {
  const { categories = [], tags = [], limit = 50, includeExamples = true } = options;

  let filteredEndpoints = API_ENDPOINTS;

  // Filter by categories
  if (categories.length > 0) {
    filteredEndpoints = filteredEndpoints.filter((endpoint) =>
      categories.includes(endpoint.category),
    );
  }

  // Filter by tags
  if (tags.length > 0) {
    filteredEndpoints = filteredEndpoints.filter((endpoint) =>
      tags.some((tag) => endpoint.tags.includes(tag)),
    );
  }

  // Limit results
  filteredEndpoints = filteredEndpoints.slice(0, limit);

  if (filteredEndpoints.length === 0) {
    return "No relevant APIs found.";
  }

  // Build context string
  const contextParts: string[] = [
    `# Eliza Cloud API Reference\n`,
    `The following APIs are available for use in generated code:\n`,
  ];

  for (const endpoint of filteredEndpoints) {
    const parts: string[] = [];

    // Endpoint header
    parts.push(`## ${endpoint.name}`);
    parts.push(`**${endpoint.method}** \`${endpoint.path}\``);
    parts.push(`\n${endpoint.description}\n`);

    // Pricing
    if (endpoint.pricing) {
      const pricing = endpoint.pricing;
      if (pricing.isFree) {
        parts.push(`**Cost**: FREE\n`);
      } else {
        parts.push(
          `**Cost**: $${pricing.cost} per ${pricing.unit}${pricing.description ? ` (${pricing.description})` : ""}\n`,
        );
      }
    }

    // Parameters
    if (endpoint.parameters) {
      const paramSections: string[] = [];

      if (endpoint.parameters.body && endpoint.parameters.body.length > 0) {
        paramSections.push("**Body Parameters:**");
        for (const param of endpoint.parameters.body) {
          const required = param.required ? " (required)" : " (optional)";
          const example =
            includeExamples && param.example ? `\n  Example: ${JSON.stringify(param.example)}` : "";
          paramSections.push(
            `- \`${param.name}\` (${param.type})${required}: ${param.description}${example}`,
          );
        }
      }

      if (endpoint.parameters.query && endpoint.parameters.query.length > 0) {
        paramSections.push("**Query Parameters:**");
        for (const param of endpoint.parameters.query) {
          const required = param.required ? " (required)" : " (optional)";
          const example =
            includeExamples && param.example ? `\n  Example: ${JSON.stringify(param.example)}` : "";
          paramSections.push(
            `- \`${param.name}\` (${param.type})${required}: ${param.description}${example}`,
          );
        }
      }

      if (paramSections.length > 0) {
        parts.push(paramSections.join("\n"));
      }
    }

    // Authentication
    if (endpoint.requiresAuth) {
      parts.push(
        `\n**Authentication**: Required. Use API key: \`Authorization: Bearer eliza_your_api_key\`\n`,
      );
    }

    // Example usage
    if (includeExamples) {
      parts.push(`**Example Request:**`);
      parts.push(`\`\`\`bash`);
      parts.push(`curl -X ${endpoint.method} \\`);
      parts.push(
        `  ${process.env.NEXT_PUBLIC_APP_URL || "https://your-domain.com"}${endpoint.path} \\`,
      );
      if (endpoint.requiresAuth) {
        parts.push(`  -H "Authorization: Bearer eliza_your_api_key" \\`);
      }
      if (endpoint.method === "POST" && endpoint.parameters?.body) {
        const exampleBody: Record<string, unknown> = {};
        for (const param of endpoint.parameters.body.slice(0, 3)) {
          if (param.example !== undefined) {
            exampleBody[param.name] = param.example;
          } else if (param.defaultValue !== undefined) {
            exampleBody[param.name] = param.defaultValue;
          }
        }
        parts.push(`  -H "Content-Type: application/json" \\`);
        parts.push(`  -d '${JSON.stringify(exampleBody, null, 2)}'`);
      }
      parts.push(`\`\`\`\n`);
    }

    contextParts.push(parts.join("\n"));
  }

  return contextParts.join("\n---\n\n");
}

/**
 * Search APIs by keyword
 */
export function searchApis(keyword: string): ApiEndpoint[] {
  const lowerKeyword = keyword.toLowerCase();
  return API_ENDPOINTS.filter(
    (endpoint) =>
      endpoint.name.toLowerCase().includes(lowerKeyword) ||
      endpoint.description.toLowerCase().includes(lowerKeyword) ||
      endpoint.path.toLowerCase().includes(lowerKeyword) ||
      endpoint.tags.some((tag) => tag.toLowerCase().includes(lowerKeyword)),
  );
}

/**
 * Get APIs by category
 */
export function getApisByCategory(category: string): ApiEndpoint[] {
  return API_ENDPOINTS.filter((endpoint) => endpoint.category === category);
}

/**
 * Get APIs by tag
 */
export function getApisByTag(tag: string): ApiEndpoint[] {
  return API_ENDPOINTS.filter((endpoint) => endpoint.tags.includes(tag));
}
