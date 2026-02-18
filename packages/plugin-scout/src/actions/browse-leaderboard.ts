import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import type { LeaderboardOptions } from "../client/types.js";
import { getScoutClient } from "../runtime-store.js";

const CATEGORIES = [
  "AI & ML",
  "Trading & DeFi",
  "Tokens & NFTs",
  "Data & Analytics",
  "Social Media",
  "Storage & Files",
  "Infrastructure",
];

function parseLeaderboardIntent(text: string): LeaderboardOptions {
  const lower = text.toLowerCase();
  const options: LeaderboardOptions = { limit: 10 };

  // Try to match a category
  for (const cat of CATEGORIES) {
    if (lower.includes(cat.toLowerCase())) {
      options.category = cat;
      break;
    }
  }

  // Shorthand category keywords
  if (!options.category) {
    if (/\bai\b|machine learning|llm|gpt/.test(lower)) options.category = "AI & ML";
    else if (/\btrad(e|ing)\b|defi|swap/.test(lower)) options.category = "Trading & DeFi";
    else if (/\bnft|token|mint/.test(lower)) options.category = "Tokens & NFTs";
    else if (/\bdata|analytic|research/.test(lower)) options.category = "Data & Analytics";
    else if (/\bsocial|tweet|x raid/.test(lower)) options.category = "Social Media";
    else if (/\bstorage|file|ipfs/.test(lower)) options.category = "Storage & Files";
  }

  // Extract search terms (quoted strings)
  const searchMatch = text.match(/["']([^"']+)["']/);
  if (searchMatch) {
    options.search = searchMatch[1];
  }

  // Extract limit
  const limitMatch = lower.match(/\btop\s+(\d+)\b|\b(\d+)\s+services?\b/);
  if (limitMatch) {
    options.limit = Math.min(parseInt(limitMatch[1] || limitMatch[2], 10), 50);
  }

  return options;
}

export const browseLeaderboardAction: Action = {
  name: "BROWSE_LEADERBOARD",
  similes: [
    "LEADERBOARD",
    "SERVICE_DIRECTORY",
    "FIND_SERVICES",
    "TOP_SERVICES",
    "DISCOVER_SERVICES",
  ],
  description:
    "Browse Scout's leaderboard of x402 services. Find trusted services by category, search, or ranking.",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const text = (message.content.text || "").toLowerCase();
    return /\b(leaderboard|top services|find services|service directory|discover|browse|best services|trusted services)\b/.test(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const client = getScoutClient(runtime);
    if (!client) {
      callback?.({ text: "Scout plugin is not properly initialized." });
      return { success: false };
    }

    const options = parseLeaderboardIntent(message.content.text || "");

    try {
      const result = await client.getLeaderboard(options);
      const { stats, services } = result;

      const lines = [
        `**Scout Service Leaderboard**${options.category ? ` - ${options.category}` : ""}${options.search ? ` (search: "${options.search}")` : ""}`,
        `_${stats.totalServices} total services, avg score ${Math.round(stats.avgServiceScore)}/100_`,
        "",
      ];

      if (services.length === 0) {
        lines.push("No services found matching your criteria.");
      } else {
        for (const svc of services) {
          const health = svc.liveness === "UP" ? "UP" : svc.liveness;
          const price = svc.priceUSD > 0 ? `$${svc.priceUSD}` : "Free";
          lines.push(
            `${svc.rank}. **${svc.domain}** - ${svc.score}/100 (${svc.level}) | ${health} | ${price} | ${svc.category}`
          );
          if (svc.description) {
            lines.push(`   _${svc.description}_`);
          }
        }
      }

      callback?.({ text: lines.join("\n") });
      return { success: true, data: result as unknown as Record<string, unknown> };
    } catch (err: any) {
      callback?.({ text: `Failed to fetch leaderboard: ${err.message}` });
      return { success: false };
    }
  },

  examples: [
    [
      { name: "User", content: { text: "Show me the top AI services on the leaderboard" } },
    ],
    [
      { name: "User", content: { text: "What are the most trusted x402 services?" } },
    ],
  ],
};