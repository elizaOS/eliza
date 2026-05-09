"use client";

import { useMemo, useState } from "react";

import type { DiscoveredApiRouteDto, HttpMethod } from "@/types/cloud-api";
import { cn } from "../../lib/utils";

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

function methodBadgeClass(method: HttpMethod) {
  const base =
    "inline-flex items-center rounded-none px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border transition-all";
  switch (method) {
    case "GET":
      return `${base} bg-emerald-500/10 text-emerald-400 border-emerald-500/30 shadow-[0_0_10px_rgba(52,211,153,0.1)]`;
    case "POST":
      return `${base} bg-blue-500/10 text-blue-400 border-blue-500/30 shadow-[0_0_10px_rgba(59,130,246,0.1)]`;
    case "PUT":
      return `${base} bg-amber-500/10 text-amber-400 border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.1)]`;
    case "PATCH":
      return `${base} bg-violet-500/10 text-violet-400 border-violet-500/30 shadow-[0_0_10px_rgba(139,92,246,0.1)]`;
    case "DELETE":
      return `${base} bg-rose-500/10 text-rose-400 border-rose-500/30 shadow-[0_0_10px_rgba(244,63,94,0.1)]`;
    default:
      return `${base} bg-white/5 text-white/60 border-white/10`;
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
    <button
      type="button"
      onClick={handleCopy}
      className="absolute top-2 right-2 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-white/40 hover:text-white/80 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 transition-all"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
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
          <div className="border border-white/10 bg-gradient-to-b from-black/60 to-black/40 overflow-hidden">
            {/* Header */}
            <div className="border-b border-white/10 p-4 bg-gradient-to-r from-[#ff5800]/5 to-transparent">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#ff5800] shadow-[0_0_8px_rgba(255,88,0,0.5)]" />
                  <span className="text-xs font-bold uppercase tracking-[0.18em] text-white/60">
                    Route Explorer
                  </span>
                </div>
                <label className="flex items-center gap-2 text-xs text-white/50 select-none cursor-pointer hover:text-white/70 transition-colors">
                  <input
                    type="checkbox"
                    checked={showAll}
                    onChange={(e) => setShowAll(e.target.checked)}
                    className="accent-[#ff5800] w-3.5 h-3.5"
                  />
                  Show all
                </label>
              </div>

              {/* Search input */}
              <div className="relative">
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search endpoints..."
                  className="w-full pl-10 pr-4 py-2.5 rounded-none border border-white/10 bg-black/40 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-[#ff5800] focus:border-[#ff5800] transition-all"
                />
              </div>

              <div className="mt-3 flex items-center justify-between text-xs text-white/40">
                <span>
                  {filtered.length} endpoint{filtered.length === 1 ? "" : "s"}
                </span>
                <span className="text-white/30">Click to view details</span>
              </div>
            </div>

            {/* Route list */}
            <div className="max-h-[65vh] overflow-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
              {groups.length === 0 ? (
                <div className="p-6 text-center text-sm text-white/40">
                  No endpoints match your search
                </div>
              ) : (
                groups.map((g) => (
                  <details
                    key={g.group}
                    open
                    className="border-b border-white/5 group"
                  >
                    <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-white/70 hover:text-white hover:bg-white/5 transition-colors flex items-center justify-between">
                      <span>{GROUP_LABELS[g.group] || g.group}</span>
                      <span className="text-xs font-normal text-white/30 bg-white/5 px-2 py-0.5 rounded-full">
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
                          <button
                            key={key}
                            type="button"
                            onClick={() => setSelectedKey(key)}
                            className={cn(
                              "w-full text-left rounded-none border px-3 py-2.5 transition-all my-1",
                              active
                                ? "bg-[#ff5800]/10 border-[#ff5800]/40 shadow-[inset_0_0_20px_rgba(255,88,0,0.05)]"
                                : "border-transparent hover:bg-white/5 hover:border-white/10",
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
                                  <span className="text-[10px] text-white/40 px-1">
                                    +{r.methods.length - 2}
                                  </span>
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div
                                  className={cn(
                                    "text-sm font-medium truncate transition-colors",
                                    active ? "text-white" : "text-white/80",
                                  )}
                                >
                                  {title}
                                </div>
                                <div className="mt-0.5 font-mono text-[10px] text-white/40 truncate">
                                  {r.path}
                                </div>
                              </div>
                            </div>
                          </button>
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
        <div className="border border-white/10 bg-gradient-to-br from-black/40 to-black/20 min-h-[400px]">
          {selected ? (
            <div className="p-6">
              {/* Endpoint header */}
              <div className="pb-5 border-b border-white/10">
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  {selected.methods.map((m) => (
                    <span key={m} className={methodBadgeClass(m)}>
                      {m}
                    </span>
                  ))}
                </div>
                <code className="block font-mono text-sm text-white bg-black/40 border border-white/10 px-4 py-3 break-all">
                  {selected.path}
                </code>
              </div>

              {/* Title and description */}
              <div className="py-5 border-b border-white/10">
                <h3 className="text-xl font-bold text-white mb-2">
                  {selected.meta?.name ||
                    selected.path.split("/").pop()?.replace(/-/g, " ") ||
                    "Endpoint"}
                </h3>
                {selected.meta?.description ? (
                  <p className="text-sm leading-relaxed text-white/60">
                    {selected.meta.description}
                  </p>
                ) : (
                  <p className="text-sm leading-relaxed text-white/40 italic">
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
                        className="text-[10px] font-medium uppercase tracking-wider px-2 py-1 bg-white/5 border border-white/10 text-white/50"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Info grid */}
              <div className="py-5 border-b border-white/10">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* Auth */}
                  <div className="p-4 bg-black/30 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <svg
                        className="w-4 h-4 text-white/40"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                        />
                      </svg>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">
                        Auth
                      </span>
                    </div>
                    <div
                      className={cn(
                        "text-sm font-medium",
                        selected.meta?.requiresAuth
                          ? "text-amber-400"
                          : "text-emerald-400",
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
                  <div className="p-4 bg-black/30 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <svg
                        className="w-4 h-4 text-white/40"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M13 10V3L4 14h7v7l9-11h-7z"
                        />
                      </svg>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">
                        Rate Limit
                      </span>
                    </div>
                    <div className="text-sm font-medium text-white/70">
                      {rateLimitDisplay}
                    </div>
                  </div>

                  {/* Category */}
                  <div className="p-4 bg-black/30 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <svg
                        className="w-4 h-4 text-white/40"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                        />
                      </svg>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">
                        Category
                      </span>
                    </div>
                    <div className="text-sm font-medium text-white/70 capitalize">
                      {selected.meta?.category ||
                        groupKeyForPath(selected.path)}
                    </div>
                  </div>

                  {/* Pricing */}
                  <div className="p-4 bg-black/30 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <svg
                        className="w-4 h-4 text-white/40"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">
                        Pricing
                      </span>
                    </div>
                    <div className="text-sm font-medium text-white/70">
                      {pricingDisplay}
                    </div>
                  </div>
                </div>
              </div>

              {/* cURL example */}
              <div className="py-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <svg
                      className="w-4 h-4 text-[#ff5800]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                    <span className="text-xs font-bold uppercase tracking-wider text-white/60">
                      Quick cURL
                    </span>
                  </div>
                </div>

                <div className="relative">
                  <pre className="overflow-x-auto border border-white/10 bg-black/60 p-4 text-[13px] leading-relaxed font-mono">
                    <code className="text-white/80">
                      <span className="text-emerald-400">curl</span>
                      <span className="text-white/60"> -X </span>
                      <span className="text-amber-400">
                        {selected.methods[0] ?? "GET"}
                      </span>
                      <span className="text-white/60"> </span>
                      <span className="text-blue-400">
                        &quot;https://www.elizacloud.ai{selected.path}&quot;
                      </span>
                      <span className="text-white/40"> \</span>
                      {"\n"}
                      <span className="text-white/60"> -H </span>
                      <span className="text-green-400">
                        &quot;Authorization: Bearer YOUR_API_KEY&quot;
                      </span>
                      {["POST", "PUT", "PATCH"].includes(
                        selected.methods[0] ?? "",
                      ) && (
                        <>
                          <span className="text-white/40"> \</span>
                          {"\n"}
                          <span className="text-white/60"> -H </span>
                          <span className="text-green-400">
                            &quot;Content-Type: application/json&quot;
                          </span>
                          <span className="text-white/40"> \</span>
                          {"\n"}
                          <span className="text-white/60"> -d </span>
                          <span className="text-purple-400">
                            &apos;{"{}"}&apos;
                          </span>
                        </>
                      )}
                    </code>
                  </pre>
                  <CopyButton text={curlExample} />
                </div>

                <p className="mt-3 text-xs text-white/40">
                  Replace{" "}
                  <code className="text-[#ff5800] bg-[#ff5800]/10 px-1.5 py-0.5">
                    YOUR_API_KEY
                  </code>{" "}
                  with your actual API key from{" "}
                  <a
                    className="text-[#ff5800] hover:underline"
                    href="/dashboard/api-keys"
                  >
                    Dashboard → API Keys
                  </a>
                </p>
              </div>

              {/* Source file reference */}
              <div className="pt-5 border-t border-white/10">
                <div className="flex items-center gap-2 text-xs text-white/30">
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                    />
                  </svg>
                  <span>Source:</span>
                  <code className="font-mono text-white/40">
                    {selected.filePath.replace(process.cwd?.() || "", "")}
                  </code>
                </div>
              </div>
            </div>
          ) : (
            /* Empty state */
            <div className="flex flex-col items-center justify-center h-full min-h-[400px] p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#ff5800]/20 to-[#ff5800]/5 flex items-center justify-center mb-4">
                <svg
                  className="w-8 h-8 text-[#ff5800]/60"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <h4 className="text-lg font-semibold text-white/80 mb-2">
                Select an Endpoint
              </h4>
              <p className="text-sm text-white/40 max-w-[280px]">
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
