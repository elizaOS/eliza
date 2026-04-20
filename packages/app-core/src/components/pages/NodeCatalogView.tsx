/**
 * NodeCatalogView — top-level browsing page for automation node descriptors.
 *
 * Fetches /api/automations/nodes and renders a filterable, searchable grid.
 * Polls every 30 s while visible so the catalog stays fresh as plugins load.
 */

import {
  Button,
  ContentLayout,
  Input,
  PagePanel,
  Spinner,
  StatusBadge,
} from "@elizaos/ui";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../api";
import type {
  AutomationNodeDescriptor,
} from "../../api/client";
import { useApp } from "../../state";
import {
  getNodeClassLabel,
  getNodeIcon,
  NODE_CLASS_ORDER,
} from "./node-catalog-icons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AvailabilityFilter = "all" | "enabled" | "needs-setup";
type ClassFilter = AutomationNodeDescriptor["class"] | "all";

const POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// NodeCard
// ---------------------------------------------------------------------------

function NodeCard({ node }: { node: AutomationNodeDescriptor }) {
  const isEnabled = node.availability === "enabled";
  return (
    <div
      role="article"
      tabIndex={0}
      aria-label={`${node.label}, ${isEnabled ? "enabled" : "needs setup"}`}
      className={`rounded-xl border px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        isEnabled
          ? "border-border/30 bg-bg/25"
          : "border-warning/20 bg-warning/5"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 shrink-0 rounded-lg p-2 ${
            isEnabled
              ? "bg-accent/10 text-accent"
              : "bg-warning/10 text-warning"
          }`}
        >
          {getNodeIcon(node)}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-txt">{node.label}</span>
            <StatusBadge
              label={isEnabled ? "Ready" : "Setup"}
              variant={isEnabled ? "success" : "warning"}
              withDot
            />
            <span className="rounded-full bg-bg/40 px-2 py-0.5 text-[11px] text-muted">
              {getNodeClassLabel(node.class)}
            </span>
            {node.ownerScoped && (
              <span className="rounded-full bg-bg/40 px-2 py-0.5 text-[11px] text-muted">
                Personal data
              </span>
            )}
            {node.requiresSetup && !isEnabled && (
              <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] text-warning">
                Needs setup
              </span>
            )}
          </div>
          <p className="line-clamp-2 text-sm text-muted">{node.description}</p>
          {node.backingCapability && (
            <p className="font-mono text-[11px] text-muted/70">
              {node.backingCapability}
            </p>
          )}
          {node.disabledReason && (
            <p className="text-xs text-warning">{node.disabledReason}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NodeCatalogView
// ---------------------------------------------------------------------------

export function NodeCatalogView() {
  const { t } = useApp();
  const [nodes, setNodes] = useState<AutomationNodeDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<ClassFilter>("all");
  const [availFilter, setAvailFilter] = useState<AvailabilityFilter>("all");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const fetchNodes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.getAutomationNodeCatalog();
      if (mountedRef.current) {
        setNodes(res.nodes ?? []);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load nodes");
      }
    } finally {
      if (mountedRef.current) {
        setLoaded(true);
        setLoading(false);
      }
    }
  }, []);

  // Initial fetch + poll while visible.
  useEffect(() => {
    mountedRef.current = true;
    void fetchNodes();
    pollTimerRef.current = setInterval(() => void fetchNodes(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [fetchNodes]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes.filter((node) => {
      if (
        classFilter !== "all" &&
        node.class !== classFilter
      ) {
        return false;
      }
      if (availFilter === "enabled" && node.availability !== "enabled") {
        return false;
      }
      if (availFilter === "needs-setup" && node.availability === "enabled") {
        return false;
      }
      if (q) {
        const haystack = [node.label, node.description, node.backingCapability]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [nodes, search, classFilter, availFilter]);

  const classCounts = useMemo(() => {
    const counts: Partial<Record<ClassFilter, number>> = { all: nodes.length };
    for (const cls of NODE_CLASS_ORDER) {
      counts[cls] = nodes.filter((n) => n.class === cls).length;
    }
    return counts;
  }, [nodes]);

  function handleRefresh() {
    void fetchNodes();
  }

  const isInitialLoad = loading && !loaded;

  return (
    <ContentLayout>
      <div className="flex min-h-0 flex-1 flex-col gap-6 px-6 py-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-txt">
              {t("nodeCatalog.title")}
            </h1>
            <p className="text-sm text-muted">{t("nodeCatalog.subtitle")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={handleRefresh}
            className="shrink-0 self-start"
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            {t("actions.refresh")}
          </Button>
        </div>

        {/* Search + filters */}
        <div className="space-y-3">
          <Input
            aria-label={t("nodeCatalog.searchPlaceholder")}
            placeholder={t("nodeCatalog.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />

          {/* Class filter */}
          <div
            role="group"
            aria-labelledby="class-filter-label"
            className="flex flex-wrap gap-2"
          >
            <span
              id="class-filter-label"
              className="sr-only"
            >
              Filter by node class
            </span>
            {(["all", ...NODE_CLASS_ORDER] as ClassFilter[]).map((cls) => (
              <button
                key={cls}
                type="button"
                role="button"
                aria-pressed={classFilter === cls}
                onClick={() => setClassFilter(cls)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  classFilter === cls
                    ? "bg-accent text-white"
                    : "bg-bg/40 text-muted hover:bg-bg/60"
                }`}
              >
                {cls === "all"
                  ? t("nodeCatalog.filterAll")
                  : getNodeClassLabel(cls)}
                {cls !== "all" && classCounts[cls] !== undefined && (
                  <span className="ml-1 opacity-70">{classCounts[cls]}</span>
                )}
              </button>
            ))}
          </div>

          {/* Availability filter */}
          <div
            role="group"
            aria-labelledby="avail-filter-label"
            className="flex flex-wrap gap-2"
          >
            <span id="avail-filter-label" className="sr-only">
              Filter by availability
            </span>
            {(
              [
                ["all", t("nodeCatalog.filterAll")],
                ["enabled", t("nodeCatalog.filterEnabled")],
                ["needs-setup", t("nodeCatalog.filterNeedsSetup")],
              ] as [AvailabilityFilter, string][]
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                role="button"
                aria-pressed={availFilter === val}
                onClick={() => setAvailFilter(val)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  availFilter === val
                    ? "bg-accent text-white"
                    : "bg-bg/40 text-muted hover:bg-bg/60"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Status line */}
        {loaded && (
          <p className="text-xs text-muted" role="status">
            {t("nodeCatalog.showingXofY", {
              shown: filtered.length,
              total: nodes.length,
            })}
          </p>
        )}

        {/* Content area */}
        {isInitialLoad ? (
          <PagePanel variant="padded">
            <div
              role="status"
              className="flex items-center justify-center gap-2 py-12 text-muted"
            >
              <Spinner className="h-5 w-5" />
              <span className="text-sm">Loading node catalog…</span>
            </div>
          </PagePanel>
        ) : error ? (
          <PagePanel variant="padded">
            <div role="status" className="space-y-2 py-8 text-center">
              <p className="text-sm text-danger">{error}</p>
              <Button variant="outline" size="sm" onClick={handleRefresh}>
                {t("common.retry")}
              </Button>
            </div>
          </PagePanel>
        ) : nodes.length === 0 ? (
          <PagePanel variant="padded">
            <div
              role="status"
              className="py-12 text-center text-sm text-muted"
            >
              {t("nodeCatalog.catalogEmpty")}
            </div>
          </PagePanel>
        ) : filtered.length === 0 ? (
          <PagePanel variant="padded">
            <div
              role="status"
              className="py-12 text-center text-sm text-muted"
            >
              {t("nodeCatalog.empty")}
            </div>
          </PagePanel>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((node) => (
              <NodeCard key={node.id} node={node} />
            ))}
          </div>
        )}
      </div>
    </ContentLayout>
  );
}
