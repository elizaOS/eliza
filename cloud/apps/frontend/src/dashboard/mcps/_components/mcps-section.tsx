/**
 * MCPs section component displaying available MCP servers in a card grid layout.
 * Includes search, category filtering, and detail view drawer.
 */

"use client";

import {
  Badge,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@elizaos/cloud-ui";
import {
  Check,
  Clock,
  Cloud,
  Coins,
  Copy,
  ExternalLink,
  HelpCircle,
  Play,
  Puzzle,
  Search,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface McpServer {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  version: string;
  category: string;
  status: "live" | "coming_soon" | "maintenance";
  pricing: {
    type: "free" | "credits" | "x402";
    description: string;
    pricePerRequest?: string;
  };
  x402Enabled: boolean;
  toolCount: number;
  icon: string;
  color: string;
  features: string[];
}

interface MCPsSectionProps {
  servers: McpServer[];
  className?: string;
}

const iconMap: Record<string, typeof Puzzle> = {
  puzzle: Puzzle,
  clock: Clock,
  cloud: Cloud,
  coins: Coins,
};

export function MCPsSection({ servers, className }: MCPsSectionProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [selectedServer, setSelectedServer] = useState<McpServer | null>(null);
  const [copiedEndpoint, setCopiedEndpoint] = useState<string | null>(null);
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const categories = ["all", ...new Set(servers.map((s) => s.category))];

  // Filter servers based on search and category
  const filteredServers = servers.filter((server) => {
    const matchesSearch =
      searchQuery === "" ||
      server.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      server.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      server.features.some((f) => f.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesCategory = categoryFilter === "all" || server.category === categoryFilter;

    return matchesSearch && matchesCategory;
  });

  const copyEndpoint = async (endpoint: string, serverId: string) => {
    const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
    const fullUrl = `${baseUrl}${endpoint}`;

    await navigator.clipboard.writeText(fullUrl);
    setCopiedEndpoint(serverId);
    toast.success("Endpoint URL copied to clipboard");
    setTimeout(() => setCopiedEndpoint(null), 2000);
  };

  const testMcpServer = async (server: McpServer) => {
    setTestingServer(server.id);
    setTestResult(null);

    try {
      let metadataUrl: string;
      if (server.endpoint === "/api/mcp") {
        metadataUrl = "/api/mcp/info";
      } else {
        metadataUrl = server.endpoint.replace(/\/(sse|mcp|http)$/, "");
      }

      const metadataResponse = await fetch(metadataUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (metadataResponse.ok) {
        const contentType = metadataResponse.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await metadataResponse.json();
          setTestResult(JSON.stringify(data, null, 2));
          toast.success(`${server.name} is responding`);
          setTestingServer(null);
          return;
        }
      }

      const mcpRequest = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "eliza-cloud-test",
            version: "1.0.0",
          },
        },
        id: "test-" + Date.now(),
      };

      const mcpResponse = await fetch(server.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(mcpRequest),
      });

      if (mcpResponse.status === 401 || mcpResponse.status === 402) {
        const data = await mcpResponse.json().catch(() => ({}));
        setTestResult(
          JSON.stringify(
            {
              status: "Server is online",
              note: "This MCP requires authentication. The server is responding correctly.",
              authRequired: true,
              statusCode: mcpResponse.status,
              ...data,
            },
            null,
            2,
          ),
        );
        toast.success(`${server.name} is online (requires auth)`);
      } else if (mcpResponse.ok) {
        const data = await mcpResponse.json();
        setTestResult(JSON.stringify(data, null, 2));
        toast.success(`${server.name} is responding`);
      } else {
        const errorText = await mcpResponse.text().catch(() => "");
        setTestResult(
          JSON.stringify(
            {
              error: `Server returned ${mcpResponse.status} ${mcpResponse.statusText}`,
              details: errorText,
            },
            null,
            2,
          ),
        );
        toast.error(`Server returned ${mcpResponse.status}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Connection failed";
      setTestResult(
        JSON.stringify(
          {
            error: errorMessage,
            hint: "The server may be offline or unreachable",
          },
          null,
          2,
        ),
      );
      toast.error(`Failed to connect: ${errorMessage}`);
    }
    setTestingServer(null);
  };

  return (
    <div className={cn("space-y-4", className)}>
      {/* What is MCP Info Card */}
      <div className="p-4 rounded-xl bg-white/5 border border-white/10">
        <h3 className="text-base font-medium text-white mb-1">What is MCP?</h3>
        <p className="text-sm text-white/60 mb-3">
          The Model Context Protocol (MCP) is an open standard that enables AI assistants to
          securely connect with data sources and tools. These MCP servers provide ready-to-use tools
          for your AI agents.
        </p>
        <div className="flex flex-wrap gap-3 text-xs">
          <div className="flex items-center gap-1.5 text-white/50">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span>Serverless & Scalable</span>
          </div>
          <div className="flex items-center gap-1.5 text-white/50">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span>x402 Micropayments</span>
          </div>
          <div className="flex items-center gap-1.5 text-white/50">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            <span>SSE & HTTP Transport</span>
          </div>
        </div>
      </div>

      {/* Section Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold text-white">MCP Servers</h2>
          <span className="text-base text-white/50">({servers.length})</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="text-white/40 hover:text-white/70 transition-colors">
                <HelpCircle className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              className="max-w-[220px] text-xs bg-zinc-900 text-white/80 border border-white/10"
            >
              MCP servers provide tools and capabilities for your AI agents.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-500" />
          <input
            type="text"
            placeholder="Search MCPs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 bg-white/5 border border-white/10 rounded-full pl-9 pr-4 text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-[#FF5800]/50 transition-colors"
          />
        </div>

        {/* Category Filters */}
        <div className="flex gap-1.5 flex-wrap">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={cn(
                "h-8 px-3.5 text-xs border rounded-full transition-colors capitalize",
                categoryFilter === cat
                  ? "bg-[#FF5800]/20 border-[#FF5800]/50 text-white"
                  : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:border-white/30 hover:text-white",
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* MCP Grid */}
      {filteredServers.length === 0 ? (
        <MCPsEmptyState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <AnimatePresence mode="popLayout">
            {filteredServers.map((server, index) => (
              <motion.div
                key={server.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ delay: index * 0.05 }}
              >
                <MCPCard server={server} onSelect={() => setSelectedServer(server)} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Server Detail Drawer */}
      <Drawer
        open={!!selectedServer}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedServer(null);
            setTestResult(null);
          }
        }}
      >
        <DrawerContent className="bg-[#0A0A0A] border-white/10 max-h-[85vh] flex flex-col">
          {selectedServer && (
            <>
              {/* Header */}
              <div className="shrink-0 flex items-start justify-between p-4 sm:p-6 border-b border-white/10">
                <div className="flex items-center gap-4">
                  <div
                    className="p-3 rounded-xl border"
                    style={{
                      backgroundColor: `${selectedServer.color}15`,
                      borderColor: `${selectedServer.color}40`,
                    }}
                  >
                    {(() => {
                      const Icon = iconMap[selectedServer.icon] || Puzzle;
                      return <Icon className="h-5 w-5" style={{ color: selectedServer.color }} />;
                    })()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <DrawerTitle className="text-base sm:text-lg font-semibold text-white flex items-center gap-2 flex-wrap">
                      <span className="truncate">{selectedServer.name}</span>
                      {selectedServer.x402Enabled && (
                        <span className="px-2 py-0.5 text-xs bg-purple-500/20 border border-purple-500/40 text-purple-400 rounded-full">
                          x402
                        </span>
                      )}
                    </DrawerTitle>
                    <DrawerDescription className="text-sm text-neutral-400 mt-1">
                      {selectedServer.description}
                    </DrawerDescription>
                  </div>
                </div>
                <DrawerClose className="p-2 hover:bg-white/10 rounded-xl transition-colors">
                  <X className="h-5 w-5 text-neutral-500" />
                </DrawerClose>
              </div>

              {/* Content */}
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent hover:scrollbar-thumb-white/30 p-4 sm:p-6">
                <div className="grid gap-6 md:grid-cols-2">
                  {/* Endpoint */}
                  <div className="flex flex-col space-y-3">
                    <label className="text-xs text-neutral-500 uppercase tracking-wider">
                      MCP Endpoint
                    </label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-white/5 border border-white/10 p-3 font-mono text-sm text-white/80 rounded-xl overflow-x-auto">
                        {typeof window !== "undefined" ? window.location.origin : ""}
                        {selectedServer.endpoint}
                      </div>
                      <button
                        onClick={() => copyEndpoint(selectedServer.endpoint, selectedServer.id)}
                        className="p-3 bg-white/5 border border-white/10 hover:border-white/30 transition-colors rounded-xl"
                      >
                        {copiedEndpoint === selectedServer.id ? (
                          <Check className="h-4 w-4 text-green-400" />
                        ) : (
                          <Copy className="h-4 w-4 text-white/60" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Config */}
                  <div className="flex flex-col space-y-3">
                    <label className="text-xs text-neutral-500 uppercase tracking-wider">
                      Configuration
                    </label>
                    <div className="bg-white/5 border border-white/10 p-3 font-mono text-xs text-white/70 rounded-xl overflow-x-auto">
                      <pre>
                        {JSON.stringify(
                          {
                            mcpServers: {
                              [selectedServer.id]: {
                                command: "npx",
                                args: [
                                  "-y",
                                  "@anthropic/mcp-client",
                                  `${typeof window !== "undefined" ? window.location.origin : ""}${selectedServer.endpoint}`,
                                ],
                              },
                            },
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  </div>
                </div>

                {/* Tools */}
                <div className="mt-6 flex flex-col space-y-3">
                  <label className="text-xs text-neutral-500 uppercase tracking-wider">
                    Available Tools ({selectedServer.toolCount})
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedServer.features.map((feature) => (
                      <span
                        key={feature}
                        className="px-3 py-1.5 text-xs border text-white/70 rounded-full"
                        style={{
                          backgroundColor: `${selectedServer.color}10`,
                          borderColor: `${selectedServer.color}30`,
                        }}
                      >
                        {feature}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Test Result */}
                {testResult && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-6 flex flex-col space-y-3"
                  >
                    <label className="text-xs text-neutral-500 uppercase tracking-wider">
                      Server Response
                    </label>
                    <div className="bg-white/5 border border-white/10 p-3 font-mono text-xs text-green-400/80 rounded-xl overflow-x-auto max-h-48 overflow-y-auto">
                      <pre>{testResult}</pre>
                    </div>
                  </motion.div>
                )}

                {/* x402 Info */}
                {selectedServer.x402Enabled && (
                  <div className="mt-6 bg-purple-500/10 border border-purple-500/30 p-4 rounded-xl">
                    <div className="flex items-center gap-2 mb-2">
                      <Zap className="h-4 w-4 text-purple-400" />
                      <span className="text-sm font-medium text-purple-300">
                        x402 Micropayments Enabled
                      </span>
                    </div>
                    <p className="text-xs text-neutral-400">
                      This MCP server supports accountless micropayments via the x402 protocol. Pay
                      only for what you use
                      {selectedServer.pricing.pricePerRequest &&
                        ` ($${selectedServer.pricing.pricePerRequest}/request)`}
                      . Powered by Coinbase CDP.
                    </p>
                  </div>
                )}
              </div>

              {/* Footer Actions */}
              <div className="shrink-0 flex items-center justify-between p-4 sm:p-6 border-t border-white/10">
                <div className="flex items-center gap-3">
                  <a
                    href={selectedServer.endpoint}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 text-white/70 hover:border-white/30 hover:text-white transition-colors rounded-xl text-sm"
                  >
                    <ExternalLink className="h-4 w-4" />
                    <span className="hidden sm:inline">Open Endpoint</span>
                  </a>
                  <button
                    className="flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 text-white/70 hover:border-white/30 hover:text-white transition-colors rounded-xl text-sm"
                    onClick={() =>
                      window.open("https://modelcontextprotocol.io/introduction", "_blank")
                    }
                  >
                    <Terminal className="h-4 w-4" />
                    <span className="hidden sm:inline">Docs</span>
                  </button>
                </div>
                <button
                  onClick={() => testMcpServer(selectedServer)}
                  disabled={testingServer === selectedServer.id}
                  className="flex items-center gap-2 px-6 py-2 bg-[#FF5800]/20 border border-[#FF5800]/30 text-[#FF5800] hover:bg-[#FF5800]/30 transition-colors rounded-xl text-sm disabled:opacity-50"
                >
                  {testingServer === selectedServer.id ? (
                    <span className="h-4 w-4 border-2 border-[#FF5800]/30 border-t-[#FF5800] rounded-full animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  Test Connection
                </button>
              </div>
            </>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}

// Individual MCP Card
function MCPCard({ server, onSelect }: { server: McpServer; onSelect: () => void }) {
  const Icon = iconMap[server.icon] || Puzzle;

  return (
    <button type="button" onClick={onSelect} className="block w-full h-full text-left">
      <div className="group relative h-full overflow-hidden rounded-xl bg-white/5 border border-white/10 transition-all duration-300 hover:border-white/20 hover:bg-white/[0.07]">
        {/* Header */}
        <div className="p-4 pb-3">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-3">
              <div
                className="p-2 rounded-xl border shrink-0"
                style={{
                  backgroundColor: `${server.color}15`,
                  borderColor: `${server.color}40`,
                }}
              >
                <Icon className="h-4 w-4" style={{ color: server.color }} />
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold text-white truncate flex items-center gap-2">
                  {server.name}
                  {server.x402Enabled && (
                    <span className="px-1.5 py-0.5 text-[9px] bg-purple-500/20 border border-purple-500/40 text-purple-400 rounded-full shrink-0">
                      x402
                    </span>
                  )}
                </h3>
                <p className="text-xs text-white/50">
                  v{server.version} - {server.toolCount} tools
                </p>
              </div>
            </div>
            <Badge
              className={cn(
                "text-[10px] px-1.5 py-0 shrink-0",
                server.status === "live"
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                  : server.status === "coming_soon"
                    ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                    : "bg-red-500/20 text-red-400 border-red-500/30",
              )}
            >
              {server.status === "live" && (
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse mr-1" />
              )}
              {server.status.replace("_", " ")}
            </Badge>
          </div>
          <p className="text-xs text-white/50 line-clamp-2 leading-relaxed min-h-[2.5rem]">
            {server.description}
          </p>
        </div>

        {/* Features */}
        <div className="px-4 pb-3">
          <div className="flex flex-wrap gap-1">
            {server.features.slice(0, 2).map((feature) => (
              <span
                key={feature}
                className="px-2 py-0.5 text-[10px] bg-white/5 border border-white/10 text-white/60 rounded-full"
              >
                {feature}
              </span>
            ))}
            {server.features.length > 2 && (
              <span className="px-2 py-0.5 text-[10px] bg-white/5 border border-white/10 text-white/40 rounded-full">
                +{server.features.length - 2}
              </span>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/5">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 text-white/40">
              {server.pricing.type === "x402" && <Zap className="h-3 w-3 text-purple-400" />}
              <span>{server.pricing.description}</span>
            </div>
            <span className="text-white/30 group-hover:text-[#FF5800] transition-colors">
              View details
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

// Empty State
function MCPsEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[160px] md:min-h-[240px] gap-4 bg-neutral-900 rounded-xl">
      <Puzzle className="h-10 w-10 text-neutral-600" />
      <h3 className="text-lg font-medium text-neutral-500">No MCPs match your search</h3>
      <p className="text-sm text-neutral-600">Try adjusting your filters or search terms</p>
    </div>
  );
}

// Skeleton Loader
export function MCPsSectionSkeleton() {
  return (
    <div className="space-y-4">
      {/* Info Card Skeleton */}
      <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
        <div className="h-5 w-32 bg-white/10 animate-pulse rounded" />
        <div className="h-3 w-full bg-white/10 animate-pulse rounded" />
        <div className="h-3 w-3/4 bg-white/10 animate-pulse rounded" />
        <div className="flex gap-3 pt-1">
          <div className="h-3 w-24 bg-white/10 animate-pulse rounded" />
          <div className="h-3 w-24 bg-white/10 animate-pulse rounded" />
          <div className="h-3 w-24 bg-white/10 animate-pulse rounded" />
        </div>
      </div>

      {/* Section Header Skeleton */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-7 w-32 bg-white/10 animate-pulse rounded" />
          <div className="h-5 w-8 bg-white/10 animate-pulse rounded" />
        </div>
      </div>

      {/* Search and Filters Skeleton */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="h-10 w-full max-w-md bg-white/10 animate-pulse rounded-full" />
        <div className="flex gap-1.5">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-8 w-16 bg-white/10 animate-pulse rounded-full" />
          ))}
        </div>
      </div>

      {/* Grid Skeleton */}
      <div className="grid gap-4 sm:grid-cols-2">
        {[...Array(4)].map((_, index) => (
          <div key={index} className="overflow-hidden rounded-xl bg-white/5 border border-white/10">
            <div className="p-4 pb-3">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 bg-white/10 animate-pulse rounded-xl" />
                  <div>
                    <div className="h-5 w-24 bg-white/10 animate-pulse rounded mb-1" />
                    <div className="h-3 w-16 bg-white/10 animate-pulse rounded" />
                  </div>
                </div>
                <div className="h-4 w-12 bg-white/10 animate-pulse rounded" />
              </div>
              <div className="space-y-1.5">
                <div className="h-3 w-full bg-white/10 animate-pulse rounded" />
                <div className="h-3 w-2/3 bg-white/10 animate-pulse rounded" />
              </div>
            </div>
            <div className="px-4 pb-3">
              <div className="flex gap-1">
                <div className="h-5 w-16 bg-white/10 animate-pulse rounded-full" />
                <div className="h-5 w-14 bg-white/10 animate-pulse rounded-full" />
              </div>
            </div>
            <div className="px-4 py-3 border-t border-white/5">
              <div className="flex items-center justify-between">
                <div className="h-3 w-20 bg-white/10 animate-pulse rounded" />
                <div className="h-3 w-16 bg-white/10 animate-pulse rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
