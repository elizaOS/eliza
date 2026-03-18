/**
 * RuntimeView — deep runtime state inspector for advanced debugging.
 *
 * Shows:
 * - Full runtime snapshot
 * - Split sections: actions/providers/plugins/services/evaluators
 * - Explicit load order metadata
 */

import { useCallback, useEffect, useState } from "react";
import {
  client,
  type RuntimeDebugSnapshot,
  type RuntimeOrderItem,
  type RuntimeServiceOrderItem,
} from "../api";
import { useApp } from "../state";
import { formatDateTime } from "./format";

type RuntimeSectionKey =
  | "runtime"
  | "actions"
  | "providers"
  | "plugins"
  | "services"
  | "evaluators";

const SECTION_TABS: Array<{ key: RuntimeSectionKey; label: string }> = [
  { key: "runtime", label: "Runtime" },
  { key: "actions", label: "Actions" },
  { key: "providers", label: "Providers" },
  { key: "plugins", label: "Plugins" },
  { key: "services", label: "Services" },
  { key: "evaluators", label: "Evaluators" },
];

function nodeSummary(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    const compact = value.length > 100 ? `${value.slice(0, 100)}...` : value;
    return JSON.stringify(compact);
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const typeTag = typeof record.__type === "string" ? record.__type : null;
    if (typeTag === "array" && typeof record.length === "number") {
      return `Array(${String(record.length)})`;
    }
    if (typeTag === "map" && typeof record.size === "number") {
      return `Map(${String(record.size)})`;
    }
    if (typeTag === "set" && typeof record.size === "number") {
      return `Set(${String(record.size)})`;
    }
    if (typeTag === "object") {
      const className =
        typeof record.className === "string" ? record.className : "Object";
      const props =
        record.properties &&
        typeof record.properties === "object" &&
        !Array.isArray(record.properties)
          ? Object.keys(record.properties as Record<string, unknown>).length
          : 0;
      return `${className} {${props}}`;
    }
    return `${typeTag ?? "Object"} {${Object.keys(record).length}}`;
  }
  return String(value);
}

function isExpandable(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== "object") return false;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function nodeEntries(
  value: unknown,
  path: string,
): Array<{ key: string; value: unknown; path: string }> {
  if (Array.isArray(value)) {
    return value.map((entry, i) => ({
      key: `[${i}]`,
      value: entry,
      path: `${path}[${i}]`,
    }));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(
    ([key, entry]) => ({
      key,
      value: entry,
      path: `${path}.${key}`,
    }),
  );
}

function buildInitialExpanded(rootPath: string, value: unknown): Set<string> {
  const expanded = new Set<string>([rootPath]);
  const firstLayer = nodeEntries(value, rootPath).slice(0, 24);
  for (const entry of firstLayer) expanded.add(entry.path);
  return expanded;
}

function orderItemLabel(entry: RuntimeOrderItem): string {
  const idPart = entry.id ? ` (${entry.id})` : "";
  return `[${entry.index}] ${entry.name} :: ${entry.className}${idPart}`;
}

function TreeNode(props: {
  label: string;
  value: unknown;
  path: string;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const { label, value, path, depth, expanded, onToggle } = props;
  const canExpand = isExpandable(value);
  const open = expanded.has(path);
  const entries = canExpand ? nodeEntries(value, path) : [];

  return (
    <div>
      <div
        className="flex items-baseline gap-1 text-[11px] font-mono leading-5"
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        {canExpand ? (
          <button
            type="button"
            onClick={() => onToggle(path)}
            className="w-4 text-left text-[var(--muted)] hover:text-[var(--txt)]"
            title={open ? "Collapse" : "Expand"}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="inline-block w-4 text-[var(--muted)]">·</span>
        )}
        <span className="text-[var(--muted)]">{label}</span>
        <span className="text-[var(--txt)]">{nodeSummary(value)}</span>
      </div>

      {canExpand && open && (
        <div>
          {entries.map((entry) => (
            <TreeNode
              key={entry.path}
              label={entry.key}
              value={entry.value}
              path={entry.path}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderCard(props: { title: string; entries: RuntimeOrderItem[] }) {
  const { t } = useApp();
  const { title, entries } = props;
  return (
    <div className="border border-[var(--border)] bg-[var(--card)] rounded-md p-3 min-h-[150px]">
      <div className="text-xs font-semibold mb-2">
        {title} ({entries.length})
      </div>
      <div className="max-h-[180px] overflow-auto text-[11px] font-mono leading-5">
        {entries.length === 0 ? (
          <div className="text-[var(--muted)]">{t("runtimeview.none")}</div>
        ) : (
          entries.map((entry) => (
            <div key={`${title}-${entry.index}`} className="text-[var(--txt)]">
              {orderItemLabel(entry)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ServicesOrderCard(props: { entries: RuntimeServiceOrderItem[] }) {
  const { t } = useApp();
  const { entries } = props;
  return (
    <div className="border border-[var(--border)] bg-[var(--card)] rounded-md p-3 min-h-[150px]">
      <div className="text-xs font-semibold mb-2">
        {t("runtimeview.Services")}
        {entries.length} {t("runtimeview.types")}
      </div>
      <div className="max-h-[180px] overflow-auto text-[11px] font-mono leading-5">
        {entries.length === 0 ? (
          <div className="text-[var(--muted)]">{t("runtimeview.none")}</div>
        ) : (
          entries.map((serviceGroup) => (
            <div
              key={`${serviceGroup.serviceType}-${serviceGroup.index}`}
              className="mb-2"
            >
              <div className="text-[var(--txt)]">
                [{serviceGroup.index}] {serviceGroup.serviceType} (
                {serviceGroup.count})
              </div>
              {serviceGroup.instances.map((instance) => (
                <div
                  key={`${serviceGroup.serviceType}-${instance.index}`}
                  className="text-[var(--muted)] pl-4"
                >
                  {orderItemLabel(instance)}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function RuntimeView() {
  const { t } = useApp();
  const [snapshot, setSnapshot] = useState<RuntimeDebugSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] =
    useState<RuntimeSectionKey>("runtime");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  const [depth, setDepth] = useState(10);
  const [maxArrayLength, setMaxArrayLength] = useState(1000);
  const [maxObjectEntries, setMaxObjectEntries] = useState(1000);

  const sectionData = snapshot?.sections[activeSection] ?? null;
  const rootPath = `$${activeSection}`;

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await client.getRuntimeSnapshot({
        depth,
        maxArrayLength,
        maxObjectEntries,
      });
      setSnapshot(next);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load runtime snapshot",
      );
    } finally {
      setLoading(false);
    }
  }, [depth, maxArrayLength, maxObjectEntries]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    setExpandedPaths(buildInitialExpanded(rootPath, sectionData));
  }, [rootPath, sectionData]);

  const handleTogglePath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return (
    <div data-testid="runtime-view" className="flex flex-col gap-4 h-full">
      <div className="flex flex-wrap items-end gap-3 border border-[var(--border)] bg-[var(--card)] rounded-md p-3">
        <label className="text-[11px] text-[var(--muted)] flex items-center gap-1">
          {t("runtimeview.depth")}
          <input
            type="number"
            min={1}
            max={24}
            value={depth}
            onChange={(e) =>
              setDepth(Math.max(1, Math.min(24, Number(e.target.value) || 1)))
            }
            className="w-16 px-1.5 py-0.5 border border-[var(--border)] bg-[var(--bg)] text-[var(--txt)] rounded-sm"
          />
        </label>
        <label className="text-[11px] text-[var(--muted)] flex items-center gap-1">
          {t("runtimeview.arrayCap")}
          <input
            type="number"
            min={1}
            max={5000}
            value={maxArrayLength}
            onChange={(e) =>
              setMaxArrayLength(
                Math.max(1, Math.min(5000, Number(e.target.value) || 1)),
              )
            }
            className="w-20 px-1.5 py-0.5 border border-[var(--border)] bg-[var(--bg)] text-[var(--txt)] rounded-sm"
          />
        </label>
        <label className="text-[11px] text-[var(--muted)] flex items-center gap-1">
          {t("runtimeview.objectCap")}
          <input
            type="number"
            min={1}
            max={5000}
            value={maxObjectEntries}
            onChange={(e) =>
              setMaxObjectEntries(
                Math.max(1, Math.min(5000, Number(e.target.value) || 1)),
              )
            }
            className="w-20 px-1.5 py-0.5 border border-[var(--border)] bg-[var(--bg)] text-[var(--txt)] rounded-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => void loadSnapshot()}
          disabled={loading}
          className="px-3 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)] hover:bg-[var(--bg-hover)] disabled:opacity-60"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
        <button
          type="button"
          onClick={() => setExpandedPaths(new Set([rootPath]))}
          className="px-3 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)] hover:bg-[var(--bg-hover)]"
        >
          {t("runtimeview.Collapse")}
        </button>
        <button
          type="button"
          onClick={() =>
            setExpandedPaths(buildInitialExpanded(rootPath, sectionData))
          }
          className="px-3 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)] hover:bg-[var(--bg-hover)]"
        >
          {t("runtimeview.ExpandTop")}
        </button>
        <div className="text-[11px] text-[var(--muted)] ml-auto">
          {snapshot
            ? `Last updated: ${formatDateTime(snapshot.generatedAt, { fallback: "n/a" })}`
            : "No snapshot loaded"}
        </div>
      </div>

      {snapshot && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <OrderCard
            title={t("runtimeview.Plugins")}
            entries={snapshot.order.plugins}
          />
          <OrderCard
            title={t("runtimeview.Actions")}
            entries={snapshot.order.actions}
          />
          <OrderCard
            title={t("runtimeview.Providers")}
            entries={snapshot.order.providers}
          />
          <OrderCard
            title={t("runtimeview.Evaluators")}
            entries={snapshot.order.evaluators}
          />
          <ServicesOrderCard entries={snapshot.order.services} />
          <div className="border border-[var(--border)] bg-[var(--card)] rounded-md p-3">
            <div className="text-xs font-semibold mb-2">
              {t("runtimeview.Summary")}
            </div>
            <div className="text-[11px] font-mono leading-5">
              <div>
                {t("runtimeview.runtime")}{" "}
                {snapshot.runtimeAvailable ? "available" : "offline"}
              </div>
              <div>
                {t("runtimeview.agent")} {snapshot.meta.agentName}
              </div>
              <div>
                {t("runtimeview.state")} {snapshot.meta.agentState}
              </div>
              <div>
                {t("runtimeview.model")} {snapshot.meta.model ?? "n/a"}
              </div>
              <div>
                {t("runtimeview.plugins")} {snapshot.meta.pluginCount}
              </div>
              <div>
                {t("runtimeview.actions")} {snapshot.meta.actionCount}
              </div>
              <div>
                {t("runtimeview.providers")} {snapshot.meta.providerCount}
              </div>
              <div>
                {t("runtimeview.evaluators")} {snapshot.meta.evaluatorCount}
              </div>
              <div>
                {t("runtimeview.services")} {snapshot.meta.serviceCount}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-[var(--border)]">
        {SECTION_TABS.map((tab) => {
          const active = tab.key === activeSection;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveSection(tab.key)}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px ${
                active
                  ? "border-accent text-txt"
                  : "border-transparent text-muted hover:text-txt hover:border-border"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 border border-[var(--border)] bg-[var(--card)] rounded-md overflow-auto p-2">
        {error ? (
          <div className="text-xs text-danger p-3">{error}</div>
        ) : !snapshot ? (
          <div className="text-xs text-[var(--muted)] p-3">
            {loading
              ? "Loading runtime snapshot..."
              : "No runtime snapshot available."}
          </div>
        ) : !snapshot.runtimeAvailable ? (
          <div className="text-xs text-[var(--muted)] p-3">
            {t("runtimeview.AgentRuntimeIsNot")}
          </div>
        ) : (
          <TreeNode
            label={activeSection}
            value={sectionData}
            path={rootPath}
            depth={0}
            expanded={expandedPaths}
            onToggle={handleTogglePath}
          />
        )}
      </div>
    </div>
  );
}
