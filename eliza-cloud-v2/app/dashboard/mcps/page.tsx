import { Suspense } from "react";
import type { Metadata } from "next";
import { requireAuthWithOrg } from "@/lib/auth";
import { MCPsPageWrapper } from "./mcps-page-wrapper";
import { MCPsSection, MCPsSectionSkeleton } from "./mcps-section";

export const metadata: Metadata = {
  title: "MCP Servers",
  description:
    "Explore and connect to Model Context Protocol (MCP) servers. Access ready-to-use tools for AI agents including time, weather, crypto prices, and more.",
};

// Auth check requires cookies which makes this dynamic
// MCP server list is hardcoded but auth is dynamic
export const dynamic = "force-dynamic";

// Demo MCP servers available for users
const demoMcpServers = [
  {
    id: "eliza-cloud-mcp",
    name: "elizaOS Cloud MCP",
    description:
      "Core elizaOS Cloud platform MCP with credit management, AI generation, memory, conversations, and agent interaction capabilities.",
    endpoint: "/api/mcp",
    version: "1.0.0",
    category: "platform",
    status: "live" as const,
    pricing: {
      type: "credits" as const,
      description: "Pay-per-use with credits",
    },
    x402Enabled: false,
    toolCount: 20,
    icon: "puzzle",
    color: "#FF5800",
    features: [
      "Credit Management",
      "AI Text Generation",
      "Image Generation",
      "Memory Storage",
      "Agent Chat",
    ],
  },
  {
    id: "time-mcp",
    name: "Time & Date MCP",
    description:
      "Get current time, timezone conversions, and date calculations. Perfect for scheduling and time-aware applications.",
    endpoint: "/api/mcps/time",
    version: "2.0.0",
    category: "utilities",
    status: "live" as const,
    pricing: {
      type: "credits" as const,
      description: "1 credit per request",
    },
    x402Enabled: false,
    toolCount: 5,
    icon: "clock",
    color: "#3B82F6",
    features: [
      "Current Time",
      "Timezone Conversion",
      "Date Formatting",
      "Time Calculations",
      "Timezone Listing",
    ],
  },
  {
    id: "weather-mcp",
    name: "Weather MCP",
    description:
      "Real-time weather data, forecasts, and location search powered by Open-Meteo API.",
    endpoint: "/api/mcps/weather",
    version: "2.0.0",
    category: "data",
    status: "live" as const,
    pricing: {
      type: "credits" as const,
      description: "1-2 credits per request",
    },
    x402Enabled: false,
    toolCount: 4,
    icon: "cloud",
    color: "#06B6D4",
    features: [
      "Current Weather",
      "16-Day Forecast",
      "Weather Comparison",
      "Location Search",
    ],
  },
  {
    id: "crypto-mcp",
    name: "Crypto Price MCP",
    description:
      "Real-time cryptocurrency prices, market data, and trending coins powered by CoinGecko API. Free to use.",
    endpoint: "/api/mcps/crypto",
    version: "2.0.0",
    category: "finance",
    status: "live" as const,
    pricing: {
      type: "free" as const,
      description: "Free",
    },
    x402Enabled: false,
    toolCount: 3,
    icon: "coins",
    color: "#F59E0B",
    features: ["Live Prices", "Market Cap Data", "Trending Coins"],
  },
];

/**
 * MCP Servers page displaying available Model Context Protocol servers.
 * Shows server cards with filtering and detail view.
 */
export default async function MCPsPage() {
  await requireAuthWithOrg();

  return (
    <MCPsPageWrapper>
      <main className="mx-auto w-full max-w-[1400px]">
        <div className="space-y-8">
          <section>
            <Suspense fallback={<MCPsSectionSkeleton />}>
              <MCPsSection servers={demoMcpServers} />
            </Suspense>
          </section>
        </div>
      </main>
    </MCPsPageWrapper>
  );
}
