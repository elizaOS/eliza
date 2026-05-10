import {
  DashboardLoadingState,
  DashboardPageContainer,
  MonacoEditorSkeleton,
  useSetPageHeader,
} from "@elizaos/cloud-ui";
import {
  ActivityIcon,
  AudioLinesIcon,
  BookIcon,
  Check,
  ChevronLeft,
  Coins,
  Copy,
  DatabaseIcon,
  KeyIcon,
  MicIcon,
  Search,
  ShieldIcon,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import {
  API_ENDPOINTS,
  type ApiEndpoint,
  type EndpointPricing,
  getAvailableCategories,
} from "@/lib/swagger/endpoint-discovery";
import {
  generateOpenAPISpec,
  generateOpenAPIYAML,
  type OpenAPISpec,
} from "@/lib/swagger/openapi-generator";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/utils/toast-adapter";
import { useRequireAuth } from "../../lib/auth-hooks";
import { ApiTester } from "./_components/api-tester";
import { AuthManager } from "./_components/auth-manager";
import { EndpointCard } from "./_components/endpoint-card";
import { useExplorerApiKey } from "./_components/use-explorer-api-key";

const OpenApiViewer = lazy(() =>
  import("./_components/openapi-viewer").then((mod) => ({
    default: mod.OpenApiViewer,
  })),
);

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

function getCategoryIcon(category: string) {
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
}

function getMethodColor(method: string) {
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
}

function formatPrice(pricing: ApiEndpoint["pricing"]) {
  if (!pricing) return null;
  if (pricing.isFree) return "Free";
  if (pricing.isVariable && pricing.estimatedRange) {
    return `$${pricing.estimatedRange.min.toFixed(3)} - $${pricing.estimatedRange.max.toFixed(2)}`;
  }
  return `$${pricing.cost.toFixed(pricing.cost < 0.01 ? 4 : 2)}`;
}

function getPricingIcon(pricing: ApiEndpoint["pricing"]) {
  if (!pricing) return null;
  if (pricing.isFree) return <Sparkles className="h-4 w-4 text-emerald-400" />;
  if (pricing.isVariable) return <TrendingUp className="h-4 w-4 text-amber-400" />;
  return <Coins className="h-4 w-4 text-[#FF5800]" />;
}

function getPricingStyle(pricing: ApiEndpoint["pricing"]) {
  if (!pricing) return "";
  if (pricing.isFree) return "bg-emerald-500/20 text-emerald-400";
  if (pricing.isVariable) return "bg-amber-500/20 text-amber-400";
  return "bg-[#FF5800]/20 text-[#FF5800]";
}

function resolveApiUrl() {
  const fromVite = import.meta.env.VITE_API_URL;
  if (typeof fromVite === "string" && fromVite.length > 0) return fromVite;
  if (typeof process !== "undefined" && typeof process.env?.NEXT_PUBLIC_API_URL === "string") {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  return "http://localhost:3000";
}

export default function ApiExplorerPage() {
  const session = useRequireAuth();

  useSetPageHeader({ title: "API Explorer" });

  const [activeTab, setActiveTab] = useState<TabValue>("endpoints");
  const [selectedEndpoint, setSelectedEndpoint] = useState<ApiEndpoint | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [openApiSpec, setOpenApiSpec] = useState<OpenAPISpec | null>(null);
  const [copied, setCopied] = useState<"json" | "yaml" | null>(null);
  const [livePricing, setLivePricing] = useState<Record<string, EndpointPricing>>({});
  const { authToken, explorerKey, isLoading, error, refreshExplorerKey, setAuthToken } =
    useExplorerApiKey();

  const categories = ["All", ...getAvailableCategories()];
  const endpointsWithLivePricing = API_ENDPOINTS.map((endpoint) => ({
    ...endpoint,
    pricing: livePricing[endpoint.id] ?? endpoint.pricing,
  }));
  const filteredEndpoints = endpointsWithLivePricing.filter((endpoint) => {
    const categoryMatches = selectedCategory === "All" || endpoint.category === selectedCategory;
    if (!categoryMatches) return false;
    if (!searchQuery) return true;

    const needle = searchQuery.toLowerCase();
    return (
      endpoint.name.toLowerCase().includes(needle) ||
      endpoint.path.toLowerCase().includes(needle) ||
      endpoint.description.toLowerCase().includes(needle) ||
      endpoint.tags.some((tag) => tag.toLowerCase().includes(needle))
    );
  });

  useEffect(() => {
    const spec = generateOpenAPISpec(resolveApiUrl());
    setOpenApiSpec(spec);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/v1/pricing/summary")
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as {
          pricing?: Record<string, EndpointPricing>;
        };
        if (!cancelled && payload.pricing) {
          setLivePricing(payload.pricing);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopyJson = async () => {
    if (!openApiSpec) return;
    await navigator.clipboard.writeText(JSON.stringify(openApiSpec, null, 2));
    setCopied("json");
    toast({ message: "OpenAPI spec copied to clipboard", mode: "success" });
    setTimeout(() => setCopied(null), 2000);
  };

  const handleCopyYaml = async () => {
    if (!openApiSpec) return;
    const yaml = generateOpenAPIYAML(resolveApiUrl());
    await navigator.clipboard.writeText(yaml);
    setCopied("yaml");
    toast({ message: "OpenAPI YAML copied to clipboard", mode: "success" });
    setTimeout(() => setCopied(null), 2000);
  };

  const helmet = (
    <Helmet>
      <title>API Explorer</title>
      <meta
        name="description"
        content="Interactive API documentation and testing interface. Explore endpoints, test requests, and view OpenAPI specifications for Eliza Cloud."
      />
    </Helmet>
  );

  if (!session.ready || !session.authenticated) {
    return (
      <>
        {helmet}
        <DashboardLoadingState label="Loading API Explorer" />
      </>
    );
  }

  return (
    <>
      {helmet}
      <DashboardPageContainer className="space-y-3 overflow-hidden sm:space-y-6">
        <div className="flex w-full items-center gap-1 overflow-x-auto rounded-lg bg-neutral-900 p-1 sm:w-fit">
          {[
            { value: "endpoints" as const, label: "Endpoints" },
            { value: "auth" as const, label: "Auth" },
            { value: "openapi" as const, label: "OpenAPI" },
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

        {activeTab === "endpoints" &&
          (selectedEndpoint ? (
            <div className="min-w-0 space-y-3 sm:space-y-6">
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
                        <span className="opacity-70">/{selectedEndpoint.pricing.unit}</span>
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
                  <code className="max-w-full truncate rounded-md border border-white/10 bg-black/40 px-2.5 py-1 font-mono text-xs text-white sm:max-w-[42rem]">
                    {selectedEndpoint.path}
                  </code>
                </div>
              </div>

              <div className="bg-neutral-900 rounded-xl p-4 md:p-6 space-y-6">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    {getCategoryIcon(selectedEndpoint.category)}
                    <h3 className="text-lg font-semibold text-white">{selectedEndpoint.name}</h3>
                  </div>
                  <p className="text-sm text-neutral-400">{selectedEndpoint.description}</p>
                </div>

                <ApiTester
                  endpoint={selectedEndpoint}
                  authToken={authToken}
                  isAuthLoading={isLoading}
                />
              </div>
            </div>
          ) : (
            <div className="min-w-0 space-y-3 sm:space-y-6">
              <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:gap-2 sm:overflow-visible sm:pb-0">
                <div className="relative min-w-[13rem] flex-1 sm:min-w-0 sm:flex-none">
                  <Search className="absolute left-2 sm:left-3 top-1/2 -translate-y-1/2 h-3.5 sm:h-4 w-3.5 sm:w-4 text-neutral-500" />
                  <input
                    type="text"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="h-7 w-full rounded-md border border-white/10 bg-neutral-900 pl-7 pr-7 text-[11px] text-white placeholder:text-neutral-500 focus:border-[#FF5800]/50 focus:outline-none focus:ring-1 focus:ring-[#FF5800]/50 sm:h-9 sm:w-48 sm:rounded-lg sm:pl-9 sm:pr-8 sm:text-sm"
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

                {categories.map((category) => {
                  const count =
                    category === "All"
                      ? endpointsWithLivePricing.length
                      : endpointsWithLivePricing.filter(
                          (endpoint) => endpoint.category === category,
                        ).length;
                  return (
                    <button
                      key={category}
                      onClick={() => {
                        setSelectedCategory(category);
                        setSearchQuery("");
                      }}
                      className={cn(
                        "flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors sm:h-9 sm:gap-2 sm:rounded-lg sm:px-3 sm:text-xs",
                        selectedCategory === category
                          ? "bg-[#FF5800]/10 text-[#FF5800] border-[#FF5800]/30"
                          : "bg-neutral-900/50 text-neutral-400 border-white/5 hover:text-white hover:border-white/10",
                      )}
                    >
                      <span>{category}</span>
                      <span
                        className={cn(
                          "text-[11px] sm:text-xs font-semibold",
                          selectedCategory === category ? "text-[#FF5800]" : "text-neutral-500",
                        )}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {!searchQuery && (
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">
                      {selectedCategory === "All" ? "All Endpoints" : selectedCategory}
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

              {searchQuery && (
                <p className="text-sm text-neutral-500">
                  {filteredEndpoints.length} endpoint
                  {filteredEndpoints.length !== 1 ? "s" : ""} matching &ldquo;{searchQuery}&rdquo;
                </p>
              )}

              {filteredEndpoints.length === 0 ? (
                <div className="flex flex-col items-center justify-center min-h-[300px] bg-neutral-900 rounded-xl">
                  <Search className="h-12 w-12 text-neutral-600 mb-4" />
                  <h3 className="text-lg font-medium text-white mb-1">No endpoints found</h3>
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

        {activeTab === "auth" && (
          <div className="max-w-md">
            <AuthManager
              authToken={authToken}
              explorerKey={explorerKey}
              isLoading={isLoading}
              error={error}
              onTokenChange={setAuthToken}
              onRefresh={refreshExplorerKey}
            />
          </div>
        )}

        {activeTab === "openapi" && (
          <div className="flex min-h-[480px] min-w-0 flex-col gap-3 overflow-hidden sm:gap-4 md:h-[calc(100dvh-212px)]">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 shrink-0">
              <div>
                <h3 className="text-sm font-medium text-white">OpenAPI 3.0 Specification</h3>
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
              <Suspense fallback={<MonacoEditorSkeleton height="600px" />}>
                <OpenApiViewer
                  value={JSON.stringify(openApiSpec, null, 2)}
                  className="flex-1 min-h-0 bg-neutral-950"
                />
              </Suspense>
            ) : (
              <div className="flex items-center justify-center flex-1 min-h-0 bg-black/40 rounded-lg border border-white/10">
                <p className="text-neutral-500">Loading specification...</p>
              </div>
            )}
          </div>
        )}
      </DashboardPageContainer>
    </>
  );
}
