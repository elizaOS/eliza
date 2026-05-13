import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  client,
  type RuntimeDebugSnapshot,
  type RuntimeOrderItem,
  type RuntimeServiceOrderItem,
} from "../../api";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useApp } from "../../state";
import { formatDateTime } from "../../utils/format";
import { PagePanel } from "../composites/page-panel";
import { MetaPill } from "../composites/page-panel/page-panel-header";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarHeader } from "../composites/sidebar/sidebar-header";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type RuntimeSectionKey =
  | "summary"
  | "runtime"
  | "actions"
  | "providers"
  | "plugins"
  | "services"
  | "evaluators";

type RuntimeTreeSectionKey = Exclude<RuntimeSectionKey, "summary">;

const SECTION_TAB_KEYS: Array<{
  key: RuntimeSectionKey;
  i18nKey: string;
}> = [
  {
    key: "summary",
    i18nKey: "runtimeview.Summary",
  },
  {
    key: "runtime",
    i18nKey: "common.runtime",
  },
  {
    key: "actions",
    i18nKey: "common.actions",
  },
  {
    key: "providers",
    i18nKey: "common.providers",
  },
  {
    key: "plugins",
    i18nKey: "common.plugins",
  },
  {
    key: "services",
    i18nKey: "runtimeview.tabServices",
  },
  {
    key: "evaluators",
    i18nKey: "common.evaluators",
  },
];

const SECTION_DESCRIPTION_KEYS: Record<RuntimeSectionKey, string> = {
  summary: "runtimeview.summaryDescription",
  runtime: "runtimeview.runtimeDescription",
  actions: "runtimeview.actionsDescription",
  providers: "runtimeview.providersDescription",
  plugins: "runtimeview.pluginsDescription",
  services: "runtimeview.servicesDescription",
  evaluators: "runtimeview.evaluatorsDescription",
};

function nodeSummary(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    const compact = value.length > 100 ? `${value.slice(0, 100)}...` : value;
    return JSON.stringify(compact);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
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
    return value.map((entry, index) => ({
      key: `[${index}]`,
      value: entry,
      path: `${path}[${index}]`,
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
  const { t } = useApp();
  const { label, value, path, depth, expanded, onToggle } = props;
  const canExpand = isExpandable(value);
  const open = expanded.has(path);
  const entries = canExpand ? nodeEntries(value, path) : [];

  return (
    <div>
      <div
        className="flex items-baseline gap-1 text-xs font-mono leading-6"
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        {canExpand ? (
          <Button
            variant="ghost"
            size="icon"
            type="button"
            onClick={() => onToggle(path)}
            className="h-5 w-5 shrink-0 rounded-md p-0 text-left text-muted hover:bg-bg-hover hover:text-txt"
            title={open ? t("common.collapse") : t("common.expand")}
          >
            {open ? "▾" : "▸"}
          </Button>
        ) : (
          <span className="inline-block w-4 text-muted">·</span>
        )}
        <span className="text-muted">{label}</span>
        <span className="min-w-0 break-all text-txt">{nodeSummary(value)}</span>
      </div>

      {canExpand && open ? (
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
      ) : null}
    </div>
  );
}

function OrderCard(props: { title: string; entries: RuntimeOrderItem[] }) {
  const { t } = useApp();
  const { title, entries } = props;

  return (
    <PagePanel variant="section" className="p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-txt">{title}</div>
        <MetaPill>{entries.length}</MetaPill>
      </div>
      <PagePanel
        variant="inset"
        className="max-h-[18rem] overflow-auto px-4 py-3 text-xs font-mono leading-6 tabular-nums"
      >
        {entries.length === 0 ? (
          <div className="text-muted">{t("runtimeview.none")}</div>
        ) : (
          entries.map((entry) => (
            <div
              key={`${title}-${entry.index}`}
              className="min-w-0 break-words text-txt"
            >
              {orderItemLabel(entry)}
            </div>
          ))
        )}
      </PagePanel>
    </PagePanel>
  );
}

function ServicesOrderCard(props: { entries: RuntimeServiceOrderItem[] }) {
  const { t } = useApp();
  const { entries } = props;

  return (
    <PagePanel variant="section" className="p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-txt">
          {t("runtimeview.Services")}
        </div>
        <MetaPill>
          {entries.length} {t("runtimeview.types")}
        </MetaPill>
      </div>
      <PagePanel
        variant="inset"
        className="max-h-[18rem] space-y-3 overflow-auto px-4 py-3 text-xs font-mono leading-6 tabular-nums"
      >
        {entries.length === 0 ? (
          <div className="text-muted">{t("runtimeview.none")}</div>
        ) : (
          entries.map((serviceGroup) => (
            <PagePanel
              key={`${serviceGroup.serviceType}-${serviceGroup.index}`}
              variant="inset"
              className="px-3 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 break-words text-txt">
                  [{serviceGroup.index}] {serviceGroup.serviceType}
                </div>
                <MetaPill>{serviceGroup.count}</MetaPill>
              </div>
              <div className="mt-2 space-y-1 pl-3 text-muted">
                {serviceGroup.instances.map((instance) => (
                  <div
                    key={`${serviceGroup.serviceType}-${instance.index}`}
                    className="min-w-0 break-words"
                  >
                    {orderItemLabel(instance)}
                  </div>
                ))}
              </div>
            </PagePanel>
          ))
        )}
      </PagePanel>
    </PagePanel>
  );
}

function RuntimeSummaryCard(props: {
  snapshot: RuntimeDebugSnapshot;
  t: (key: string) => string;
}) {
  const { snapshot, t } = props;

  const summaryRows = [
    {
      label: t("runtimeview.runtime"),
      value: snapshot.runtimeAvailable
        ? t("runtimeview.available")
        : t("common.offline"),
    },
    { label: t("runtimeview.agent"), value: snapshot.meta.agentName },
    { label: t("runtimeview.state"), value: snapshot.meta.agentState },
    { label: t("runtimeview.model"), value: snapshot.meta.model ?? "n/a" },
    {
      label: t("runtimeview.plugins"),
      value: String(snapshot.meta.pluginCount),
    },
    {
      label: t("runtimeview.actions"),
      value: String(snapshot.meta.actionCount),
    },
    {
      label: t("runtimeview.providers"),
      value: String(snapshot.meta.providerCount),
    },
    {
      label: t("runtimeview.evaluators"),
      value: String(snapshot.meta.evaluatorCount),
    },
    {
      label: t("runtimeview.services"),
      value: String(snapshot.meta.serviceCount),
    },
  ];

  return (
    <PagePanel variant="section" className="p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-txt">
          {t("runtimeview.Summary")}
        </div>
        <div
          className={
            snapshot.runtimeAvailable
              ? "rounded-full border border-ok/30 bg-ok/10 px-2.5 py-1 text-xs-tight font-medium text-ok"
              : "rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs-tight font-medium text-warning"
          }
        >
          {snapshot.runtimeAvailable
            ? t("runtimeview.available")
            : t("common.offline")}
        </div>
      </div>
      <div className="grid gap-2 text-xs tabular-nums">
        {summaryRows.map((row) => (
          <PagePanel
            key={row.label}
            variant="inset"
            className="flex items-start justify-between gap-3 px-3 py-2"
          >
            <span className="text-muted">{row.label}</span>
            <span className="min-w-0 break-all text-right font-semibold text-txt">
              {row.value}
            </span>
          </PagePanel>
        ))}
      </div>
    </PagePanel>
  );
}

export function RuntimeView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const { t } = useApp();
  const [snapshot, setSnapshot] = useState<RuntimeDebugSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] =
    useState<RuntimeSectionKey>("summary");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [depth, setDepth] = useState(10);
  const [maxArrayLength, setMaxArrayLength] = useState(1000);
  const [maxObjectEntries, setMaxObjectEntries] = useState(1000);
  const snapshotRequestIdRef = useRef(0);

  const sectionData =
    activeSection === "summary"
      ? (snapshot?.sections.runtime ?? null)
      : (snapshot?.sections[activeSection as RuntimeTreeSectionKey] ?? null);
  const rootPath =
    activeSection === "summary" ? "$runtime" : `$${activeSection}`;

  const loadSnapshot = useCallback(async () => {
    const requestId = snapshotRequestIdRef.current + 1;
    snapshotRequestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const next = await client.getRuntimeSnapshot({
        depth,
        maxArrayLength,
        maxObjectEntries,
      });
      if (snapshotRequestIdRef.current !== requestId) return;
      setSnapshot(next);
    } catch (err) {
      if (snapshotRequestIdRef.current !== requestId) return;
      setError(
        err instanceof Error ? err.message : "Failed to load runtime snapshot",
      );
    } finally {
      if (snapshotRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [depth, maxArrayLength, maxObjectEntries]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    setExpandedPaths(buildInitialExpanded(rootPath, sectionData));
  }, [rootPath, sectionData]);

  const handleTogglePath = useCallback((path: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const sectionMeta: Record<RuntimeSectionKey, string> = {
    summary: snapshot
      ? `${snapshot.meta.pluginCount + snapshot.meta.providerCount + snapshot.meta.evaluatorCount} signals`
      : "overview",
    runtime: snapshot
      ? `${Object.keys(snapshot.sections.runtime ?? {}).length} roots`
      : "raw tree",
    actions: snapshot ? "registered handlers" : "actions",
    providers: snapshot ? "loaded contexts" : "providers",
    plugins: snapshot ? "active modules" : "plugins",
    services: snapshot ? "instantiated services" : "services",
    evaluators: snapshot ? "decision hooks" : "evaluators",
  };

  const getSectionCount = (sectionKey: RuntimeSectionKey) => {
    if (!snapshot) return null;
    switch (sectionKey) {
      case "summary":
        return null;
      case "runtime":
        return snapshot.runtimeAvailable ? "live" : "offline";
      case "actions":
        return String(snapshot.order.actions.length);
      case "providers":
        return String(snapshot.order.providers.length);
      case "plugins":
        return String(snapshot.order.plugins.length);
      case "services":
        return String(snapshot.order.services.length);
      case "evaluators":
        return String(snapshot.order.evaluators.length);
    }
  };

  const filteredSections = sidebarSearch
    ? SECTION_TAB_KEYS.filter((s) =>
        t(s.i18nKey).toLowerCase().includes(sidebarSearch.toLowerCase()),
      )
    : SECTION_TAB_KEYS;

  const runtimeSidebar = (
    <AppPageSidebar
      testId="runtime-sidebar"
      collapsible
      contentIdentity="runtime"
    >
      <SidebarHeader
        search={{
          value: sidebarSearch,
          onChange: (e) => setSidebarSearch(e.target.value),
          placeholder: t("runtimeview.filterSections", {
            defaultValue: "Filter sections",
          }),
          "aria-label": t("runtimeview.filterSections", {
            defaultValue: "Filter sections",
          }),
          onClear: () => setSidebarSearch(""),
        }}
      />
      <SidebarPanel>
        <PagePanel.SummaryCard compact className="mt-2 space-y-2">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: programmatic control association is preserved */}
          <label className="flex flex-col gap-1 text-xs-tight text-muted">
            <span>{t("runtimeview.depth")}</span>
            <Input
              type="number"
              min={1}
              max={24}
              value={depth}
              onChange={(event) =>
                setDepth(
                  Math.max(1, Math.min(24, Number(event.target.value) || 1)),
                )
              }
              className="relative overflow-hidden border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_86%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_18px_28px_-24px_rgba(15,23,42,0.12)] backdrop-blur-md transition-[border-color,background-color,box-shadow] duration-200 before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.24),transparent)] hover:border-border/40 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] focus-within:border-accent/24 focus-within:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] focus-within:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_20px_30px_-24px_rgba(15,23,42,0.14)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_30px_-26px_rgba(0,0,0,0.24)] h-9 rounded-xl px-3 text-sm text-txt"
            />
          </label>

          {/* biome-ignore lint/a11y/noLabelWithoutControl: programmatic control association is preserved */}
          <label className="flex flex-col gap-1 text-xs-tight text-muted">
            <span>{t("runtimeview.arrayCap")}</span>
            <Input
              type="number"
              min={1}
              max={5000}
              value={maxArrayLength}
              onChange={(event) =>
                setMaxArrayLength(
                  Math.max(1, Math.min(5000, Number(event.target.value) || 1)),
                )
              }
              className="relative overflow-hidden border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_86%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_18px_28px_-24px_rgba(15,23,42,0.12)] backdrop-blur-md transition-[border-color,background-color,box-shadow] duration-200 before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.24),transparent)] hover:border-border/40 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] focus-within:border-accent/24 focus-within:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] focus-within:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_20px_30px_-24px_rgba(15,23,42,0.14)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_30px_-26px_rgba(0,0,0,0.24)] h-9 rounded-xl px-3 text-sm text-txt"
            />
          </label>

          {/* biome-ignore lint/a11y/noLabelWithoutControl: programmatic control association is preserved */}
          <label className="flex flex-col gap-1 text-xs-tight text-muted">
            <span>{t("runtimeview.objectCap")}</span>
            <Input
              type="number"
              min={1}
              max={5000}
              value={maxObjectEntries}
              onChange={(event) =>
                setMaxObjectEntries(
                  Math.max(1, Math.min(5000, Number(event.target.value) || 1)),
                )
              }
              className="relative overflow-hidden border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_86%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_18px_28px_-24px_rgba(15,23,42,0.12)] backdrop-blur-md transition-[border-color,background-color,box-shadow] duration-200 before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.24),transparent)] hover:border-border/40 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] focus-within:border-accent/24 focus-within:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] focus-within:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_20px_30px_-24px_rgba(15,23,42,0.14)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_30px_-26px_rgba(0,0,0,0.24)] h-9 rounded-xl px-3 text-sm text-txt"
            />
          </label>

          <div className="grid grid-cols-2 gap-1.5 pt-0.5">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void loadSnapshot()}
              disabled={loading}
              className={
                loading
                  ? "h-8 rounded-full px-3.5 text-2xs font-semibold tracking-[0.12em] border border-accent/26 bg-[linear-gradient(180deg,rgba(var(--accent-rgb),0.16),rgba(var(--accent-rgb),0.07))] text-txt-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_14px_22px_-18px_rgba(var(--accent-rgb),0.24)] ring-1 ring-inset ring-accent/10 hover:border-accent/42 hover:bg-[linear-gradient(180deg,rgba(var(--accent-rgb),0.2),rgba(var(--accent-rgb),0.1))] hover:text-txt-strong"
                  : "h-8 rounded-full px-3.5 text-2xs font-semibold tracking-[0.12em] border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 disabled:hover:border-border/32 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] disabled:hover:text-muted-strong dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_24px_-20px_rgba(0,0,0,0.24)]"
              }
            >
              {loading ? t("common.refreshing") : t("common.refresh")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() =>
                setExpandedPaths(buildInitialExpanded(rootPath, sectionData))
              }
              className="h-8 rounded-full px-3.5 text-2xs font-semibold tracking-[0.12em] border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 disabled:hover:border-border/32 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] disabled:hover:text-muted-strong dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_24px_-20px_rgba(0,0,0,0.24)]"
              disabled={activeSection === "summary"}
            >
              {t("runtimeview.ExpandTop")}
            </Button>
          </div>
        </PagePanel.SummaryCard>

        <SidebarContent.SectionLabel className="mt-3">
          {t("runtimeview.sections")}
        </SidebarContent.SectionLabel>
        <SidebarScrollRegion className="mt-2">
          <div className="space-y-1.5">
            {filteredSections.map((section) => {
              const active = section.key === activeSection;
              return (
                <SidebarContent.Item
                  key={section.key}
                  active={active}
                  onClick={() => setActiveSection(section.key)}
                  aria-current={active ? "page" : undefined}
                >
                  <SidebarContent.ItemIcon active={active}>
                    {section.key === "summary"
                      ? "Σ"
                      : t(section.i18nKey).charAt(0).toUpperCase()}
                  </SidebarContent.ItemIcon>
                  <span className="min-w-0 flex-1 text-left">
                    <SidebarContent.ItemTitle>
                      {t(section.i18nKey)}
                    </SidebarContent.ItemTitle>
                    <SidebarContent.ItemDescription>
                      {sectionMeta[section.key]}
                    </SidebarContent.ItemDescription>
                  </span>
                  {getSectionCount(section.key) ? (
                    <MetaPill compact>{getSectionCount(section.key)}</MetaPill>
                  ) : null}
                </SidebarContent.Item>
              );
            })}
          </div>
        </SidebarScrollRegion>
      </SidebarPanel>
    </AppPageSidebar>
  );

  return (
    <PageLayout
      sidebar={runtimeSidebar}
      contentHeader={contentHeader}
      data-testid="runtime-view"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {error ? (
          <div className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        ) : null}

        {!snapshot ? (
          <PagePanel.Empty
            variant="panel"
            className="min-h-[24rem]"
            description={t("runtimeview.loadingDescription")}
            title={
              loading
                ? t("runtimeview.loadingSnapshot")
                : t("runtimeview.noSnapshotAvailable")
            }
          />
        ) : !snapshot.runtimeAvailable ? (
          <PagePanel.Empty
            variant="panel"
            className="min-h-[24rem] border-warning/25 bg-warning/10 text-warning"
            description={t("runtimeview.runtimePendingDescription")}
            title={t("runtimeview.AgentRuntimeIsNot")}
          />
        ) : activeSection === "summary" ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <OrderCard
              title={t("common.plugins")}
              entries={snapshot.order.plugins}
            />
            <OrderCard
              title={t("common.actions")}
              entries={snapshot.order.actions}
            />
            <OrderCard
              title={t("common.providers")}
              entries={snapshot.order.providers}
            />
            <OrderCard
              title={t("common.evaluators")}
              entries={snapshot.order.evaluators}
            />
            <ServicesOrderCard entries={snapshot.order.services} />
            <RuntimeSummaryCard snapshot={snapshot} t={t} />
          </div>
        ) : (
          <>
            <PagePanel variant="padded">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
                    {t("runtimeview.sectionLabel")}
                  </div>
                  <div className="mt-2 text-[2rem] font-semibold leading-tight text-txt">
                    {t(
                      SECTION_TAB_KEYS.find(
                        (section) => section.key === activeSection,
                      )?.i18nKey ?? "runtimeview.runtime",
                    )}
                  </div>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
                    {t(SECTION_DESCRIPTION_KEYS[activeSection])}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => setExpandedPaths(new Set([rootPath]))}
                    className="h-8 rounded-full px-3.5 text-2xs font-semibold tracking-[0.12em] border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 disabled:hover:border-border/32 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] disabled:hover:text-muted-strong dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_24px_-20px_rgba(0,0,0,0.24)]"
                  >
                    {t("common.collapse")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() =>
                      setExpandedPaths(
                        buildInitialExpanded(rootPath, sectionData),
                      )
                    }
                    className="h-8 rounded-full px-3.5 text-2xs font-semibold tracking-[0.12em] border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 disabled:hover:border-border/32 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] disabled:hover:text-muted-strong dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_24px_-20px_rgba(0,0,0,0.24)]"
                  >
                    {t("runtimeview.ExpandTop")}
                  </Button>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <PagePanel variant="inset" className="px-4 py-4">
                  <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
                    {t("runtimeview.path")}
                  </div>
                  <div className="mt-2 font-mono text-sm text-txt">
                    {rootPath}
                  </div>
                </PagePanel>
                <PagePanel variant="inset" className="px-4 py-4">
                  <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
                    {t("runtimeview.lastUpdated")}
                  </div>
                  <div className="mt-2 text-sm font-semibold text-txt">
                    {formatDateTime(snapshot.generatedAt, {
                      fallback: "n/a",
                    })}
                  </div>
                </PagePanel>
                <PagePanel variant="inset" className="px-4 py-4">
                  <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
                    {t("runtimeview.depth")}
                  </div>
                  <div className="mt-2 text-sm font-semibold text-txt">
                    {depth}
                  </div>
                </PagePanel>
                <PagePanel variant="inset" className="px-4 py-4">
                  <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
                    {t("runtimeview.objectCap")}
                  </div>
                  <div className="mt-2 text-sm font-semibold text-txt">
                    {maxObjectEntries}
                  </div>
                </PagePanel>
              </div>
            </PagePanel>

            <PagePanel
              variant="surface"
              className="min-h-[24rem] flex-1 overflow-auto p-4"
            >
              {sectionData == null ? (
                <PagePanel.Empty
                  variant="inset"
                  description={t("runtimeview.noSectionData")}
                  title={t("runtimeview.sectionUnavailable")}
                />
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
            </PagePanel>
          </>
        )}
      </div>
    </PageLayout>
  );
}
