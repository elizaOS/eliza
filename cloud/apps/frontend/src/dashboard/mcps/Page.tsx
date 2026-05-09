import {
  DashboardLoadingState,
  DashboardPageContainer,
  DashboardPageStack,
} from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { useRequireAuth } from "../../lib/auth-hooks";
import { MCPsPageWrapper } from "./_components/mcps-page-wrapper";
import { MCPsSection } from "./_components/mcps-section";

const demoMcpServers = [
  {
    id: "eliza-cloud-mcp",
    name: "Eliza Cloud MCP",
    description:
      "Core Eliza Cloud platform MCP with credit management, AI generation, memory, conversations, and agent interaction capabilities.",
    endpoint: "/api/mcp",
    version: "1.0.0",
    category: "platform",
    status: "live" as const,
    pricing: { type: "credits" as const, description: "Pay-per-use with credits" },
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
    pricing: { type: "credits" as const, description: "1 credit per request" },
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
    pricing: { type: "credits" as const, description: "1-2 credits per request" },
    x402Enabled: false,
    toolCount: 4,
    icon: "cloud",
    color: "#06B6D4",
    features: ["Current Weather", "16-Day Forecast", "Weather Comparison", "Location Search"],
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
    pricing: { type: "free" as const, description: "Free" },
    x402Enabled: false,
    toolCount: 3,
    icon: "coins",
    color: "#F59E0B",
    features: ["Live Prices", "Market Cap Data", "Trending Coins"],
  },
];

export default function MCPsPage() {
  const { ready, authenticated } = useRequireAuth();

  if (!ready || !authenticated) return <DashboardLoadingState label="Loading MCPs" />;

  return (
    <>
      <Helmet>
        <title>MCP Servers</title>
        <meta
          name="description"
          content="Explore and connect to Model Context Protocol (MCP) servers. Access ready-to-use tools for AI agents including time, weather, crypto prices, and more."
        />
      </Helmet>
      <MCPsPageWrapper>
        <DashboardPageContainer>
          <DashboardPageStack>
            <section>
              <MCPsSection servers={demoMcpServers} />
            </section>
          </DashboardPageStack>
        </DashboardPageContainer>
      </MCPsPageWrapper>
    </>
  );
}
