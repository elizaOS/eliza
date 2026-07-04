/**
 * Runtime inspector page: fetches a deep snapshot of the live AgentRuntime
 * (services, actions, providers, evaluators, plugins, and their registration
 * order) and renders it as a sidebar-navigated, expandable object tree. Depth
 * and array/object caps are user-adjustable and encoded into the cache key so
 * distinct fetch parameters revalidate independently instead of colliding.
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import {
  client,
  type RuntimeDebugSnapshot,
  type RuntimeOrderItem,
  type RuntimeServiceOrderItem,
} from "../../api";
import { getCached, setCached } from "../../hooks/resource-cache";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useAppSelector } from "../../state";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import { formatDateTime } from "../../utils/format";
import { PagePanel } from "../composites/page-panel";
import { MetaPill } from "../composites/page-panel/page-panel-header";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DetailSkeleton } from "../ui/skeleton-layouts";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

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
  const t = useAppSelector((s) => s.t);
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
            className="h-5 w-5 shrink-0 rounded-sm p-0 text-left text-muted hover:bg-bg-hover hover:text-txt"
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
  const t = useAppSelector((s) => s.t);
  const { title, entries } = props;

  return (
    <PagePanel variant="section" className="p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-txt">{title}</div>
        <MetaPill>{entries.length}</MetaPill>
      </div>
      <div className="max-h-[18rem] overflow-auto text-xs font-mono leading-6 tabular-nums">
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
      </div>
    </PagePanel>
  );
}

function ServicesOrderCard(props: { entries: RuntimeServiceOrderItem[] }) {
  const t = useAppSelector((s) => s.t);
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
      <div className="max-h-[18rem] divide-y divide-border/40 overflow-auto text-xs font-mono leading-6 tabular-nums">
        {entries.length === 0 ? (
          <div className="text-muted">{t("runtimeview.none")}</div>
        ) : (
          entries.map((serviceGroup) => (
            <div
              key={`${serviceGroup.serviceType}-${serviceGroup.index}`}
              className="py-2 first:pt-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 break-words text-txt">
                  [{serviceGroup.index}] {serviceGroup.serviceType}
                </div>
                <MetaPill>{serviceGroup.count}</MetaPill>
              </div>
              <div className="mt-1 space-y-1 pl-3 text-muted">
                {serviceGroup.instances.map((instance) => (
                  <div
                    key={`${serviceGroup.serviceType}-${instance.index}`}
                    className="min-w-0 break-words"
                  >
                    {orderItemLabel(instance)}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </PagePanel>
  );
}

function RuntimeSummaryCard(props: {
  snapshot: RuntimeDebugSnapshot;
  t: (key: string) => string;
}) {
  const { snapshot, t } = props;

  const summaryRows = [
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
        <span
          className={
            snapshot.runtimeAvailable
              ? "inline-flex items-center gap-1.5 text-xs-tight font-medium text-ok"
              : "inline-flex items-center gap-1.5 text-xs-tight font-medium text-accent"
          }
        >
          <span
            className={
              snapshot.runtimeAvailable
                ? "h-1.5 w-1.5 rounded-full bg-ok"
                : "h-1.5 w-1.5 rounded-full bg-accent"
            }
          />
          {snapshot.runtimeAvailable
            ? t("runtimeview.available")
            : t("common.offline")}
        </span>
      </div>
      <div className="divide-y divide-border/40 text-xs tabular-nums">
        {summaryRows.map((row) => (
          <div
            key={row.label}
            className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
          >
            <span className="text-muted">{row.label}</span>
            <span className="min-w-0 break-all text-right font-semibold text-txt">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </PagePanel>
  );
}

function RuntimeSectionItem(props: {
  section: { key: RuntimeSectionKey; i18nKey: string };
  active: boolean;
  label: string;
  meta: string;
  count: string | null;
  onSelect: (key: RuntimeSectionKey) => void;
}) {
  const { section, active, label, meta, count, onSelect } = props;
  const control = useAgentElement<HTMLElement>({
    id: `runtime-section-${section.key}`,
    role: "tab",
    label,
    group: "runtime-sections",
    status: active ? "active" : "inactive",
    description: meta,
    onActivate: () => onSelect(section.key),
  });
  return (
    <SidebarContent.Item
      ref={control.ref}
      role="tab"
      aria-selected={active}
      active={active}
      onClick={() => onSelect(section.key)}
      aria-current={active ? "page" : undefined}
      {...control.agentProps}
    >
      <SidebarContent.ItemIcon active={active}>
        {section.key === "summary" ? "Σ" : label.charAt(0).toUpperCase()}
      </SidebarContent.ItemIcon>
      <span className="min-w-0 flex-1 text-left">
        <SidebarContent.ItemTitle>{label}</SidebarContent.ItemTitle>
        <SidebarContent.ItemDescription>{meta}</SidebarContent.ItemDescription>
      </span>
      {count ? <MetaPill compact>{count}</MetaPill> : null}
    </SidebarContent.Item>
  );
}

export function RuntimeView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const t = useAppSelector((s) => s.t);
  const [depth, setDepth] = useState(10);
  const [maxArrayLength, setMaxArrayLength] = useState(1000);
  const [maxObjectEntries, setMaxObjectEntries] = useState(1000);
  // Seed from the shared cache so a revisit paints the last-known snapshot
  // instantly and revalidates silently, instead of flashing a spinner. The key
  // carries every fetch parameter so distinct depth/cap combos don't collide.
  const snapshotCacheKey = `runtime-snapshot:${depth}:${maxArrayLength}:${maxObjectEntries}`;
  const cachedSnapshot = getCached<RuntimeDebugSnapshot>(snapshotCacheKey);
  const [snapshot, setSnapshot] = useState<RuntimeDebugSnapshot | null>(
    cachedSnapshot?.data ?? null,
  );
  const [loading, setLoading] = useState(!cachedSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] =
    useState<RuntimeSectionKey>("summary");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const snapshotRequestIdRef = useRef(0);
  const depthInputId = useId();
  const arrayCapInputId = useId();
  const objectCapInputId = useId();

  const sectionData =
    activeSection === "summary"
      ? (snapshot?.sections.runtime ?? null)
      : (snapshot?.sections[activeSection as RuntimeTreeSectionKey] ?? null);
  const rootPath =
    activeSection === "summary" ? "$runtime" : `$${activeSection}`;

  const loadSnapshot = useCallback(
    async (options?: { silent?: boolean }) => {
      const requestId = snapshotRequestIdRef.current + 1;
      snapshotRequestIdRef.current = requestId;
      if (!options?.silent) setLoading(true);
      setError(null);
      try {
        const next = await client.getRuntimeSnapshot({
          depth,
          maxArrayLength,
          maxObjectEntries,
        });
        if (snapshotRequestIdRef.current !== requestId) return;
        setSnapshot(next);
        setCached(snapshotCacheKey, next);
      } catch (err) {
        if (snapshotRequestIdRef.current !== requestId) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load runtime snapshot",
        );
      } finally {
        if (snapshotRequestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [depth, maxArrayLength, maxObjectEntries, snapshotCacheKey],
  );

  useEffect(() => {
    // Revalidate silently when this snapshot is already cached on screen.
    void loadSnapshot({
      silent: getCached<RuntimeDebugSnapshot>(snapshotCacheKey) != null,
    });
  }, [loadSnapshot, snapshotCacheKey]);

  // Keep the snapshot live without a manual refresh button: poll silently while
  // the view is mounted and the window is visible so a backgrounded window goes
  // quiet, then resumes on return.
  useIntervalWhenDocumentVisible(() => {
    void loadSnapshot({ silent: true });
  }, 5000);

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

  // The floating chat composer becomes this view's section filter: while Runtime
  // is open it takes over the composer placeholder and feeds the live draft into
  // sidebarSearch via onQuery. setSidebarSearch is a stable useState setter.
  const filterPlaceholder = t("runtimeview.filterSections", {
    defaultValue: "Filter sections",
  });
  const chatBinding = useMemo(
    () => ({ placeholder: filterPlaceholder, onQuery: setSidebarSearch }),
    [filterPlaceholder],
  );
  useRegisterViewChatBinding(chatBinding);

  const expandTop = useCallback(() => {
    setExpandedPaths(buildInitialExpanded(rootPath, sectionData));
  }, [rootPath, sectionData]);
  const collapseTree = useCallback(() => {
    setExpandedPaths(new Set([rootPath]));
  }, [rootPath]);

  const sidebarExpandControl = useAgentElement<HTMLButtonElement>({
    id: "runtime-expand-top",
    role: "button",
    label: t("runtimeview.ExpandTop"),
    group: "runtime-tree",
    description: "Expand the top layer of the active runtime section tree",
    onActivate: expandTop,
  });
  const treeCollapseControl = useAgentElement<HTMLButtonElement>({
    id: "runtime-tree-collapse",
    role: "button",
    label: t("common.collapse"),
    group: "runtime-tree",
    description: "Collapse the active runtime section tree to its root",
    onActivate: collapseTree,
  });
  const treeExpandControl = useAgentElement<HTMLButtonElement>({
    id: "runtime-tree-expand-top",
    role: "button",
    label: t("runtimeview.ExpandTop"),
    group: "runtime-tree",
    description: "Expand the top layer of the active runtime section tree",
    onActivate: expandTop,
  });

  const runtimeSidebar = (
    <AppPageSidebar
      testId="runtime-sidebar"
      collapsible
      contentIdentity="runtime"
    >
      <SidebarPanel>
        <div className="mt-2 space-y-2">
          <Button
            ref={sidebarExpandControl.ref}
            variant="outline"
            size="sm"
            type="button"
            onClick={expandTop}
            disabled={activeSection === "summary"}
            className="h-8 w-full rounded-full text-xs-tight font-semibold"
            {...sidebarExpandControl.agentProps}
          >
            {t("runtimeview.ExpandTop")}
          </Button>

          <details className="text-xs-tight text-muted">
            <summary className="cursor-pointer select-none rounded-sm px-1 py-1 text-muted-strong hover:text-txt">
              {t("nav.advanced")}
            </summary>
            <div className="mt-2 space-y-2 px-1">
              <label
                htmlFor={depthInputId}
                className="flex flex-col gap-1 text-xs-tight text-muted"
              >
                <span>{t("runtimeview.depth")}</span>
                <Input
                  id={depthInputId}
                  type="number"
                  density="compact"
                  min={1}
                  max={24}
                  value={depth}
                  onChange={(event) =>
                    setDepth(
                      Math.max(
                        1,
                        Math.min(24, Number(event.target.value) || 1),
                      ),
                    )
                  }
                />
              </label>

              <label
                htmlFor={arrayCapInputId}
                className="flex flex-col gap-1 text-xs-tight text-muted"
              >
                <span>{t("runtimeview.arrayCap")}</span>
                <Input
                  id={arrayCapInputId}
                  type="number"
                  density="compact"
                  min={1}
                  max={5000}
                  value={maxArrayLength}
                  onChange={(event) =>
                    setMaxArrayLength(
                      Math.max(
                        1,
                        Math.min(5000, Number(event.target.value) || 1),
                      ),
                    )
                  }
                />
              </label>

              <label
                htmlFor={objectCapInputId}
                className="flex flex-col gap-1 text-xs-tight text-muted"
              >
                <span>{t("runtimeview.objectCap")}</span>
                <Input
                  id={objectCapInputId}
                  type="number"
                  density="compact"
                  min={1}
                  max={5000}
                  value={maxObjectEntries}
                  onChange={(event) =>
                    setMaxObjectEntries(
                      Math.max(
                        1,
                        Math.min(5000, Number(event.target.value) || 1),
                      ),
                    )
                  }
                />
              </label>
            </div>
          </details>
        </div>

        <SidebarScrollRegion className="mt-3">
          <div className="space-y-1.5">
            {filteredSections.map((section) => (
              <RuntimeSectionItem
                key={section.key}
                section={section}
                active={section.key === activeSection}
                label={t(section.i18nKey)}
                meta={sectionMeta[section.key]}
                count={getSectionCount(section.key)}
                onSelect={setActiveSection}
              />
            ))}
          </div>
        </SidebarScrollRegion>
      </SidebarPanel>
    </AppPageSidebar>
  );

  return (
    <ShellViewAgentSurface viewId="runtime">
      <PageLayout
        sidebar={runtimeSidebar}
        contentHeader={contentHeader}
        data-testid="runtime-view"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {error ? (
            <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>
          ) : null}

          {loading && !snapshot ? (
            <DetailSkeleton className="min-h-[24rem]" />
          ) : !snapshot ? (
            <PagePanel.Empty
              variant="panel"
              className="min-h-[24rem]"
              description={t("runtimeview.loadingDescription")}
              title={t("runtimeview.noSnapshotAvailable")}
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
                  <div className="text-[2rem] font-semibold leading-tight text-txt">
                    {t(
                      SECTION_TAB_KEYS.find(
                        (section) => section.key === activeSection,
                      )?.i18nKey ?? "runtimeview.runtime",
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      ref={treeCollapseControl.ref}
                      variant="outline"
                      size="sm"
                      type="button"
                      onClick={collapseTree}
                      className="h-8 rounded-full text-xs-tight font-semibold"
                      {...treeCollapseControl.agentProps}
                    >
                      {t("common.collapse")}
                    </Button>
                    <Button
                      ref={treeExpandControl.ref}
                      variant="outline"
                      size="sm"
                      type="button"
                      onClick={expandTop}
                      className="h-8 rounded-full text-xs-tight font-semibold"
                      {...treeExpandControl.agentProps}
                    >
                      {t("runtimeview.ExpandTop")}
                    </Button>
                  </div>
                </div>

                <div className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <div className="text-xs-tight text-muted">
                      {t("runtimeview.path")}
                    </div>
                    <div className="mt-1 font-mono text-sm text-txt">
                      {rootPath}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight text-muted">
                      {t("runtimeview.lastUpdated")}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-txt">
                      {formatDateTime(snapshot.generatedAt, {
                        fallback: "n/a",
                      })}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight text-muted">
                      {t("runtimeview.depth")}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-txt">
                      {depth}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs-tight text-muted">
                      {t("runtimeview.objectCap")}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-txt">
                      {maxObjectEntries}
                    </div>
                  </div>
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
    </ShellViewAgentSurface>
  );
}
