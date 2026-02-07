"use client";

import { toast } from "@/lib/utils/toast-adapter";
import {
  ActivityIcon,
  AudioLinesIcon,
  BookIcon,
  DatabaseIcon,
  KeyIcon,
  MicIcon,
  Search,
  ShieldIcon,
  X,
  Coins,
  Sparkles,
  TrendingUp,
  ChevronLeft,
  Copy,
  Check,
} from "lucide-react";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

import {
  API_ENDPOINTS,
  getAvailableCategories,
  getEndpointsByCategory,
  searchEndpoints,
  type ApiEndpoint,
} from "@/lib/swagger/endpoint-discovery";
import {
  generateOpenAPISpec,
  type OpenAPISpec,
} from "@/lib/swagger/openapi-generator";

import { ApiTester } from "@/components/api-explorer/api-tester";
import { AuthManager } from "@/components/api-explorer/auth-manager";
import { EndpointCard } from "@/components/api-explorer/endpoint-card";
import { MonacoEditorSkeleton } from "@/components/chat/monaco-editor-skeleton";

const OpenApiViewer = dynamic(
  () =>
    import("@/components/api-explorer/openapi-viewer").then(
      (mod) => mod.OpenApiViewer,
    ),
  {
    ssr: false,
    loading: () => <MonacoEditorSkeleton height="600px" />,
  },
);
import { useSetPageHeader } from "@/components/layout/page-header-context";
import { cn } from "@/lib/utils";

const categoryDescriptions: Record<string, string> = {
  All: "Explore the complete set of API endpoints available in the Eliza platform.",
  Authentication: "Securely authenticate users and manage access tokens.",
  Agents: "Create, configure, and manage your AI agents.",
  Memories: "Access and manipulate agent memory systems.",
  Documents: "Upload and process documents for RAG.",
  Chat: "Interact with agents via chat interfaces.",
  Usage: "Track API usage, quotas, and billing information.",
};

type TabValue = "endpoints" | "auth" | "openapi";

export default function ApiExplorerPage() {
  useSetPageHeader({
    title: "API Explorer",
  });

  const [activeTab, setActiveTab] = useState<TabValue>("endpoints");
  const [selectedEndpoint, setSelectedEndpoint] = useState<ApiEndpoint | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [openApiSpec, setOpenApiSpec] = useState<OpenAPISpec | null>(null);
  const [authToken, setAuthToken] = useState<string>("");
  const [copied, setCopied] = useState<"json" | "yaml" | null>(null);

  const categories = ["All", ...getAvailableCategories()];
  const filteredEndpoints = searchQuery
    ? searchEndpoints(searchQuery)
    : selectedCategory === "All"
      ? API_ENDPOINTS
      : getEndpointsByCategory(selectedCategory);

  useEffect(() => {
    try {
      const spec = generateOpenAPISpec(
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000",
      );
      setOpenApiSpec(spec);
    } catch {
      toast({
        message: "Failed to generate API specification",
        mode: "error",
      });
    }
  }, []);

  const getCategoryIcon = (category: string) => {
    switch (category.toLowerCase()) {
      case "authentication":
        return <ShieldIcon className="h-4 w-4" />;
      case "api keys":
        return <KeyIcon className="h-4 w-4" />;
      case "ai generation":
      case "ai completions":
      case "image generation":
      case "video generation":
        return <ActivityIcon className="h-4 w-4" />;
      case "voice generation":
        return <MicIcon className="h-4 w-4" />;
      case "voice cloning":
        return <AudioLinesIcon className="h-4 w-4" />;
      case "models":
        return <DatabaseIcon className="h-4 w-4" />;
      default:
        return <BookIcon className="h-4 w-4" />;
    }
  };

  const getMethodColor = (method: string) => {
    switch (method) {
      case "GET":
        return "bg-emerald-500/20 text-emerald-400";
      case "POST":
        return "bg-blue-500/20 text-blue-400";
      case "PUT":
        return "bg-amber-500/20 text-amber-400";
      case "DELETE":
        return "bg-rose-500/20 text-rose-400";
      case "PATCH":
        return "bg-violet-500/20 text-violet-400";
      default:
        return "bg-white/10 text-white/60";
    }
  };

  const formatPrice = (pricing: ApiEndpoint["pricing"]) => {
    if (!pricing) return null;
    if (pricing.isFree) return "Free";
    if (pricing.isVariable && pricing.estimatedRange) {
      return `$${pricing.estimatedRange.min.toFixed(3)} - $${pricing.estimatedRange.max.toFixed(2)}`;
    }
    return `$${pricing.cost.toFixed(pricing.cost < 0.01 ? 4 : 2)}`;
  };

  const getPricingIcon = (pricing: ApiEndpoint["pricing"]) => {
    if (!pricing) return null;
    if (pricing.isFree)
      return <Sparkles className="h-4 w-4 text-emerald-400" />;
    if (pricing.isVariable)
      return <TrendingUp className="h-4 w-4 text-amber-400" />;
    return <Coins className="h-4 w-4 text-[#FF5800]" />;
  };

  const getPricingStyle = (pricing: ApiEndpoint["pricing"]) => {
    if (!pricing) return "";
    if (pricing.isFree) return "bg-emerald-500/20 text-emerald-400";
    if (pricing.isVariable) return "bg-amber-500/20 text-amber-400";
    return "bg-[#FF5800]/20 text-[#FF5800]";
  };

  const handleCopyJson = async () => {
    if (openApiSpec) {
      await navigator.clipboard.writeText(JSON.stringify(openApiSpec, null, 2));
      setCopied("json");
      toast({ message: "OpenAPI spec copied to clipboard", mode: "success" });
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const handleCopyYaml = async () => {
    if (openApiSpec) {
      const { generateOpenAPIYAML } =
        await import("@/lib/swagger/openapi-generator");
      const yaml = generateOpenAPIYAML();
      await navigator.clipboard.writeText(yaml);
      setCopied("yaml");
      toast({ message: "OpenAPI YAML copied to clipboard", mode: "success" });
      setTimeout(() => setCopied(null), 2000);
    }
  };

  return (
    <div className="w-0 min-w-full max-w-[1400px] mx-auto space-y-3 sm:space-y-6 overflow-hidden">
      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-neutral-900 rounded-lg w-fit">
        {[
          {
            value: "endpoints" as const,
            label: "Endpoints",
            shortLabel: "Endpoints",
          },
          { value: "auth" as const, label: "Auth", shortLabel: "Auth" },
          {
            value: "openapi" as const,
            label: "OpenAPI",
            shortLabel: "OpenAPI",
          },
        ].map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={cn(
              "px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap",
              activeTab === tab.value
                ? "bg-white/10 text-white"
                : "text-neutral-400 hover:text-white",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Endpoints Tab */}
      {activeTab === "endpoints" &&
        (selectedEndpoint ? (
          <div className="space-y-3 sm:space-y-6 min-w-0">
            {/* Back button and endpoint info */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <button
                onClick={() => setSelectedEndpoint(null)}
                className="flex items-center gap-2 text-sm text-neutral-400 hover:text-white transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
                Back to endpoints
              </button>
              <div className="flex items-center gap-2 flex-wrap">
                {selectedEndpoint.pricing && (
                  <div
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium",
                      getPricingStyle(selectedEndpoint.pricing),
                    )}
                  >
                    {getPricingIcon(selectedEndpoint.pricing)}
                    <span>{formatPrice(selectedEndpoint.pricing)}</span>
                    {!selectedEndpoint.pricing.isFree && (
                      <span className="opacity-70">
                        /{selectedEndpoint.pricing.unit}
                      </span>
                    )}
                  </div>
                )}
                <span
                  className={cn(
                    "px-2.5 py-1 rounded-md text-xs font-bold uppercase",
                    getMethodColor(selectedEndpoint.method),
                  )}
                >
                  {selectedEndpoint.method}
                </span>
                <code className="px-2.5 py-1 rounded-md bg-black/40 border border-white/10 font-mono text-xs text-white">
                  {selectedEndpoint.path}
                </code>
              </div>
            </div>

            {/* Endpoint detail card */}
            <div className="bg-neutral-900 rounded-xl p-4 md:p-6 space-y-6">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  {getCategoryIcon(selectedEndpoint.category)}
                  <h3 className="text-lg font-semibold text-white">
                    {selectedEndpoint.name}
                  </h3>
                </div>
                <p className="text-sm text-neutral-400">
                  {selectedEndpoint.description}
                </p>
              </div>

              <ApiTester endpoint={selectedEndpoint} authToken={authToken} />
            </div>
          </div>
        ) : (
          <div className="space-y-3 sm:space-y-6 min-w-0">
            {/* Search and filters bar */}
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              {/* Search input */}
              <div className="relative">
                <Search className="absolute left-2 sm:left-3 top-1/2 -translate-y-1/2 h-3.5 sm:h-4 w-3.5 sm:w-4 text-neutral-500" />
                <input
                  type="text"
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-32 sm:w-48 h-7 sm:h-9 pl-7 sm:pl-9 pr-7 sm:pr-8 rounded-md sm:rounded-lg border border-white/10 bg-neutral-900 text-white text-[11px] sm:text-sm placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-[#FF5800]/50 focus:border-[#FF5800]/50"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-1.5 sm:right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white transition-colors"
                  >
                    <X className="h-3.5 sm:h-4 w-3.5 sm:w-4" />
                  </button>
                )}
              </div>

              {/* Category filters */}
              {categories.map((category) => {
                const count =
                  category === "All"
                    ? API_ENDPOINTS.length
                    : getEndpointsByCategory(category).length;
                return (
                  <button
                    key={category}
                    onClick={() => {
                      setSelectedCategory(category);
                      setSearchQuery("");
                    }}
                    className={cn(
                      "h-7 sm:h-9 flex items-center gap-1 sm:gap-2 px-2 sm:px-3 text-[11px] sm:text-xs font-medium rounded-md sm:rounded-lg border transition-colors",
                      selectedCategory === category
                        ? "bg-[#FF5800]/10 text-[#FF5800] border-[#FF5800]/30"
                        : "bg-neutral-900/50 text-neutral-400 border-white/5 hover:text-white hover:border-white/10",
                    )}
                  >
                    <span>{category}</span>
                    <span
                      className={cn(
                        "text-[11px] sm:text-xs font-semibold",
                        selectedCategory === category
                          ? "text-[#FF5800]"
                          : "text-neutral-500",
                      )}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Category description */}
            {!searchQuery && (
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    {selectedCategory === "All"
                      ? "All Endpoints"
                      : selectedCategory}
                    <span className="ml-2 text-sm font-normal text-neutral-500">
                      ({filteredEndpoints.length})
                    </span>
                  </h2>
                  <p className="text-sm text-neutral-500 mt-1">
                    {categoryDescriptions[selectedCategory] ||
                      `Browse ${selectedCategory} endpoints.`}
                  </p>
                </div>
              </div>
            )}

            {/* Search results count */}
            {searchQuery && (
              <p className="text-sm text-neutral-500">
                {filteredEndpoints.length} endpoint
                {filteredEndpoints.length !== 1 ? "s" : ""} matching &ldquo;
                {searchQuery}&rdquo;
              </p>
            )}

            {/* Endpoints grid */}
            {filteredEndpoints.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[300px] bg-neutral-900 rounded-xl">
                <Search className="h-12 w-12 text-neutral-600 mb-4" />
                <h3 className="text-lg font-medium text-white mb-1">
                  No endpoints found
                </h3>
                <p className="text-sm text-neutral-500">
                  {searchQuery
                    ? `No endpoints match "${searchQuery}"`
                    : "No endpoints in this category"}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 min-w-0">
                {filteredEndpoints.map((endpoint) => (
                  <EndpointCard
                    key={endpoint.id}
                    endpoint={endpoint}
                    onSelect={setSelectedEndpoint}
                    getMethodColor={getMethodColor}
                    getCategoryIcon={getCategoryIcon}
                  />
                ))}
              </div>
            )}
          </div>
        ))}

      {/* Auth Tab */}
      {activeTab === "auth" && (
        <div className="max-w-md">
          <AuthManager authToken={authToken} onTokenChange={setAuthToken} />
        </div>
      )}

      {/* OpenAPI Tab */}
      {activeTab === "openapi" && (
        <div className="flex flex-col gap-3 sm:gap-4 w-0 min-w-full overflow-hidden h-[calc(100vh-160px)] sm:h-[calc(100vh-174px)] md:h-[calc(100vh-212px)]">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 shrink-0">
            <div>
              <h3 className="text-sm font-medium text-white">
                OpenAPI 3.0 Specification
              </h3>
              <p className="text-xs text-neutral-400 mt-0.5">
                Import into Postman, Insomnia, or other tools
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCopyJson}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#FF5800] text-white rounded-lg hover:bg-[#FF5800]/90 transition-colors"
              >
                {copied === "json" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                JSON
              </button>
              <button
                onClick={handleCopyYaml}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors"
              >
                {copied === "yaml" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                YAML
              </button>
            </div>
          </div>

          {openApiSpec ? (
            <OpenApiViewer
              value={JSON.stringify(openApiSpec, null, 2)}
              className="flex-1 min-h-0 bg-neutral-950"
            />
          ) : (
            <div className="flex items-center justify-center flex-1 min-h-0 bg-black/40 rounded-lg border border-white/10">
              <p className="text-neutral-500">Loading specification...</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
