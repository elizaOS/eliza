"use client";

/**
 * Interactive API-route explorer: filter/select a discovered route and view its details.
 */
import {
  Check,
  Copy,
  DollarSign,
  FileCode2,
  Lock,
  Search,
  Tag,
  Terminal,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { cn } from "../../lib/utils";
import type { DiscoveredApiRouteDto, HttpMethod } from "../../types/cloud-api";

type RouteGroup = {
  group: string;
  routes: DiscoveredApiRouteDto[];
};

// Pretty group names for display
const GROUP_LABELS: Record<string, string> = {
  agents: "Agents",
  "api-keys": "API Keys",
  "app-builder": "App Builder",
  apps: "Applications",
  chat: "Chat",
  containers: "Containers",
  credits: "Credits & Billing",
  dashboard: "Dashboard",
  discovery: "Discovery",
  embeddings: "Embeddings",
  "external-service": "External Services",
  gallery: "Gallery",
  "generate-image": "Image Generation",
  "generate-video": "Video Generation",
  knowledge: "Knowledge Base",
  mcps: "MCP Integrations",
  models: "Models",
  redemptions: "Redemptions",
  responses: "Responses",
  user: "User",
  x402: "x402 Payments",
};

// HTTP method badges use semantic/status tokens only (no rainbow raw hex).
// The brand palette is black/white/orange + one status-green, so methods are
// differentiated by the tokenized status ramp rather than arbitrary colors:
//   GET    -> success (safe, read-only)
//   POST   -> accent (the brand action color)
//   PUT    -> warning (mutating)
//   PATCH  -> info (neutral, partial update)
//   DELETE -> destructive (orange-by-design in this system)
function methodBadgeClass(method: HttpMethod) {
  const base =
    "inline-flex items-center rounded-sm px-2.5 py-1 text-2xs font-bold uppercase tracking-wider border transition-colors";
  switch (method) {
    case "GET":
      return `${base} bg-status-success-bg text-status-success border-status-success/30`;
    case "POST":
      return `${base} bg-accent-subtle text-accent border-accent/30`;
    case "PUT":
      return `${base} bg-status-warning-bg text-status-warning border-status-warning/30`;
    case "PATCH":
      return `${base} bg-status-info-bg text-status-info border-status-info/30`;
    case "DELETE":
      return `${base} bg-destructive-subtle text-destructive border-destructive/30`;
    default:
      return `${base} bg-bg-muted text-muted border-border`;
  }
}

function isProbablyPublic(route: DiscoveredApiRouteDto) {
  const p = route.path;
  if (p.includes("/api/v1/admin/")) return false;
  if (p.includes("/api/v1/cron/")) return false;
  if (p.includes("/api/v1/iap/")) return false;
  return true;
}

function groupKeyForPath(p: string) {
  const parts = p.split("/").filter(Boolean);
  const group = parts[2] ?? "root";
  return group;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      variant="ghost"
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className="absolute top-2 right-2 inline-flex min-h-touch items-center gap-1.5 rounded-sm border border-border bg-bg-elevated px-2.5 py-1 text-2xs font-medium uppercase tracking-wider text-muted transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-txt"
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3.5 text-status-success" strokeWidth={2} />
      ) : (
        <Copy aria-hidden="true" className="size-3.5" strokeWidth={2} />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function generateCurlExample(route: DiscoveredApiRouteDto): string {
  const method = route.methods[0] ?? "GET";
  const isBodyMethod = ["POST", "PUT", "PATCH"].includes(method);

  let curl = `curl -X ${method} "https://www.elizacloud.ai${route.path}"`;
  curl += ` \\\n  -H "Authorization: Bearer YOUR_API_KEY"`;

  if (isBodyMethod) {
    curl += ` \\\n  -H "Content-Type: application/json"`;
    curl += ` \\\n  -d '{}'`;
  }

  return curl;
}

export function ApiRouteExplorerClient({
  routes,
}: {
  routes: DiscoveredApiRouteDto[];
}) {
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = showAll ? routes : routes.filter(isProbablyPublic);
    if (!q) return base;
    return base.filter((r) => {
      const hay = [
        r.path,
        r.methods.join(" "),
        r.meta?.name ?? "",
        r.meta?.description ?? "",
        r.meta?.category ?? "",
        (r.meta?.tags ?? []).join(" "),
      ]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [query, routes, showAll]);

  const groups = useMemo<RouteGroup[]>(() => {
    const map = new Map<string, DiscoveredApiRouteDto[]>();
    for (const r of filtered) {
      const key = groupKeyForPath(r.path);
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([group, rs]) => ({
        group,
        routes: rs.sort((a, b) => a.path.localeCompare(b.path)),
      }));
  }, [filtered]);

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return (
      routes.find((r) => `${r.path}::${r.methods.join(",")}` === selectedKey) ??
      null
    );
  }, [routes, selectedKey]);

  const curlExample = selected ? generateCurlExample(selected) : "";
  const rateLimitDisplay: string = selected
    ? typeof selected.meta?.rateLimit === "string"
      ? selected.meta.rateLimit
      : selected.meta?.rateLimit
        ? `${selected.meta.rateLimit.requests}/${selected.meta.rateLimit.window}`
        : "60/min"
    : "60/min";

  const pricingDisplay: string = selected
    ? typeof selected.meta?.pricing === "string"
      ? selected.meta.pricing
      : selected.meta?.pricing && "type" in selected.meta.pricing
        ? String(selected.meta.pricing.type)
        : "Credits"
    : "Credits";

  return (
    <div className="not-prose">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* Left explorer panel */}
        <div className="lg:sticky lg:top-4 h-fit">
          <div className="border border-border bg-card overflow-hidden rounded-md">
            {/* Header */}
            <div className="border-b border-border p-4 bg-bg-elevated">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-accent" />
                  <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted">
                    Route Explorer
                  </span>
                </div>
                <label
                  htmlFor="api-route-explorer-show-all"
                  className="flex min-h-touch items-center gap-2 text-xs text-muted select-none cursor-pointer hover:text-txt transition-colors"
                >
                  <Input
                    id="api-route-explorer-show-all"
                    type="checkbox"
                    checked={showAll}
                    onChange={(e) => setShowAll(e.target.checked)}
                    className="accent-[var(--accent)] w-3.5 h-3.5"
                  />
                  Show all
                </label>
              </div>

              {/* Search input */}
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted"
                  strokeWidth={2}
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search endpoints..."
                  className="w-full min-h-touch pl-10 pr-4 py-2.5 rounded-sm border border-border bg-bg text-sm text-txt placeholder:text-muted transition-colors"
                />
              </div>

              <div className="mt-3 flex items-center justify-between text-xs text-muted">
                <span>
                  {filtered.length} endpoint{filtered.length === 1 ? "" : "s"}
                </span>
                <span className="text-muted">Click to view details</span>
              </div>
            </div>

            {/* Route list */}
            <div className="max-h-[65vh] overflow-auto">
              {groups.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted">
                  No endpoints match your search
                </div>
              ) : (
                groups.map((g) => (
                  <details
                    key={g.group}
                    open
                    className="border-b border-border group"
                  >
                    <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-muted-strong hover:text-txt hover:bg-bg-hover transition-colors flex min-h-touch items-center justify-between">
                      <span>{GROUP_LABELS[g.group] || g.group}</span>
                      <span className="text-xs font-normal text-muted bg-bg-muted px-2 py-0.5 rounded-full">
                        {g.routes.length}
                      </span>
                    </summary>
                    <div className="px-2 pb-2">
                      {g.routes.map((r) => {
                        const key = `${r.path}::${r.methods.join(",")}`;
                        const active = selectedKey === key;
                        const title =
                          r.meta?.name ??
                          r.path.replace("/api/v1/", "").replace(/\//g, " / ");
                        return (
                          <Button
                            variant="ghost"
                            key={key}
                            type="button"
                            onClick={() => setSelectedKey(key)}
                            className={cn(
                              "w-full min-h-touch text-left rounded-sm border px-3 py-2.5 transition-colors my-1",
                              active
                                ? "bg-accent-subtle border-accent/40"
                                : "border-transparent hover:bg-bg-hover hover:border-border",
                            )}
                          >
                            <div className="flex items-start gap-2">
                              <div className="flex flex-wrap gap-1 pt-0.5 shrink-0">
                                {(r.methods.length
                                  ? r.methods
                                  : (["GET"] as HttpMethod[])
                                )
                                  .slice(0, 2)
                                  .map((m) => (
                                    <span
                                      key={m}
                                      className={methodBadgeClass(m)}
                                    >
                                      {m}
                                    </span>
                                  ))}
                                {r.methods.length > 2 && (
                                  <span className="text-2xs text-muted px-1">
                                    +{r.methods.length - 2}
                                  </span>
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div
                                  className={cn(
                                    "text-sm font-medium truncate transition-colors",
                                    active ? "text-txt-strong" : "text-muted-strong",
                                  )}
                                >
                                  {title}
                                </div>
                                <div className="mt-0.5 font-mono text-2xs text-muted truncate">
                                  {r.path}
                                </div>
                              </div>
                            </div>
                          </Button>
                        );
                      })}
                    </div>
                  </details>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right details panel */}
        <div className="border border-border bg-card rounded-md min-h-[400px]">
          {selected ? (
            <div className="p-6">
              {/* Endpoint header */}
              <div className="pb-5 border-b border-border">
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  {selected.methods.map((m) => (
                    <span key={m} className={methodBadgeClass(m)}>
                      {m}
                    </span>
                  ))}
                </div>
                <code className="block font-mono text-sm text-txt-strong bg-bg border border-border rounded-sm px-4 py-3 break-all">
                  {selected.path}
                </code>
              </div>

              {/* Title and description */}
              <div className="py-5 border-b border-border">
                <h3 className="text-xl font-bold text-txt-strong mb-2">
                  {selected.meta?.name ||
                    selected.path.split("/").pop()?.replace(/-/g, " ") ||
                    "Endpoint"}
                </h3>
                {selected.meta?.description ? (
                  <p className="text-sm leading-relaxed text-muted">
                    {selected.meta.description}
                  </p>
                ) : (
                  <p className="text-sm leading-relaxed text-muted italic">
                    This endpoint is available but doesn&apos;t have detailed
                    documentation yet. Check the source file or API response for
                    parameter details.
                  </p>
                )}

                {/* Tags */}
                {selected.meta?.tags && selected.meta.tags.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selected.meta.tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wider rounded-sm px-2 py-1 bg-bg-muted border border-border text-muted"
                      >
                        <Tag aria-hidden="true" className="size-3" strokeWidth={2} />
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Info grid */}
              <div className="py-5 border-b border-border">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* Auth */}
                  <div className="p-4 bg-bg border border-border rounded-sm">
                    <div className="flex items-center gap-2 mb-2">
                      <Lock
                        aria-hidden="true"
                        className="size-4 text-muted"
                        strokeWidth={2}
                      />
                      <span className="text-2xs font-bold uppercase tracking-wider text-muted">
                        Auth
                      </span>
                    </div>
                    <div
                      className={cn(
                        "text-sm font-medium",
                        selected.meta?.requiresAuth
                          ? "text-status-warning"
                          : "text-status-success",
                      )}
                    >
                      {selected.meta
                        ? selected.meta.requiresAuth
                          ? "Required"
                          : "Public"
                        : "Required"}
                    </div>
                  </div>

                  {/* Rate Limit */}
                  <div className="p-4 bg-bg border border-border rounded-sm">
                    <div className="flex items-center gap-2 mb-2">
                      <Zap
                        aria-hidden="true"
                        className="size-4 text-muted"
                        strokeWidth={2}
                      />
                      <span className="text-2xs font-bold uppercase tracking-wider text-muted">
                        Rate Limit
                      </span>
                    </div>
                    <div className="text-sm font-medium text-muted-strong">
                      {rateLimitDisplay}
                    </div>
                  </div>

                  {/* Category */}
                  <div className="p-4 bg-bg border border-border rounded-sm">
                    <div className="flex items-center gap-2 mb-2">
                      <Tag
                        aria-hidden="true"
                        className="size-4 text-muted"
                        strokeWidth={2}
                      />
                      <span className="text-2xs font-bold uppercase tracking-wider text-muted">
                        Category
                      </span>
                    </div>
                    <div className="text-sm font-medium text-muted-strong capitalize">
                      {selected.meta?.category ||
                        groupKeyForPath(selected.path)}
                    </div>
                  </div>

                  {/* Pricing */}
                  <div className="p-4 bg-bg border border-border rounded-sm">
                    <div className="flex items-center gap-2 mb-2">
                      <DollarSign
                        aria-hidden="true"
                        className="size-4 text-muted"
                        strokeWidth={2}
                      />
                      <span className="text-2xs font-bold uppercase tracking-wider text-muted">
                        Pricing
                      </span>
                    </div>
                    <div className="text-sm font-medium text-muted-strong">
                      {pricingDisplay}
                    </div>
                  </div>
                </div>
              </div>

              {/* cURL example */}
              <div className="py-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Terminal
                      aria-hidden="true"
                      className="size-4 text-accent"
                      strokeWidth={2}
                    />
                    <span className="text-xs font-bold uppercase tracking-wider text-muted">
                      Quick cURL
                    </span>
                  </div>
                </div>

                <div className="relative">
                  <pre className="overflow-x-auto border border-border bg-bg rounded-sm p-4 text-xs-tight leading-relaxed font-mono">
                    <code className="text-muted-strong">
                      <span className="text-status-success">curl</span>
                      <span className="text-muted"> -X </span>
                      <span className="text-status-warning">
                        {selected.methods[0] ?? "GET"}
                      </span>
                      <span className="text-muted"> </span>
                      <span className="text-status-info">
                        &quot;https://www.elizacloud.ai{selected.path}&quot;
                      </span>
                      <span className="text-muted"> \</span>
                      {"\n"}
                      <span className="text-muted"> -H </span>
                      <span className="text-status-success">
                        &quot;Authorization: Bearer YOUR_API_KEY&quot;
                      </span>
                      {["POST", "PUT", "PATCH"].includes(
                        selected.methods[0] ?? "",
                      ) && (
                        <>
                          <span className="text-muted"> \</span>
                          {"\n"}
                          <span className="text-muted"> -H </span>
                          <span className="text-status-success">
                            &quot;Content-Type: application/json&quot;
                          </span>
                          <span className="text-muted"> \</span>
                          {"\n"}
                          <span className="text-muted"> -d </span>
                          <span className="text-accent">
                            &apos;{"{}"}&apos;
                          </span>
                        </>
                      )}
                    </code>
                  </pre>
                  <CopyButton text={curlExample} />
                </div>

                <p className="mt-3 text-xs text-muted">
                  Replace{" "}
                  <code className="text-accent bg-accent-subtle rounded-sm px-1.5 py-0.5">
                    YOUR_API_KEY
                  </code>{" "}
                  with your actual API key from{" "}
                  <a
                    className="text-accent hover:underline"
                    href="/dashboard/api-keys"
                  >
                    Dashboard → API Keys
                  </a>
                </p>
              </div>

              {/* Source file reference */}
              <div className="pt-5 border-t border-border">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <FileCode2
                    aria-hidden="true"
                    className="size-4"
                    strokeWidth={2}
                  />
                  <span>Source:</span>
                  <code className="font-mono text-muted">
                    {selected.filePath.replace(process.cwd?.() || "", "")}
                  </code>
                </div>
              </div>
            </div>
          ) : (
            /* Empty state */
            <div className="flex flex-col items-center justify-center h-full min-h-[400px] p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-accent-subtle flex items-center justify-center mb-4">
                <Terminal
                  aria-hidden="true"
                  className="size-8 text-accent"
                  strokeWidth={1.5}
                />
              </div>
              <h4 className="text-lg font-semibold text-txt-strong mb-2">
                Select an Endpoint
              </h4>
              <p className="text-sm text-muted max-w-[280px]">
                Choose an endpoint from the list to view details, authentication
                requirements, and example code.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
