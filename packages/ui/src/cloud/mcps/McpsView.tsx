/**
 * MCP registry management view (app-hosted Eliza Cloud surface), backed by
 * the real registry:
 *   - "My MCPs" tab  → `GET /api/v1/mcps?scope=own`  (CRUD + publish)
 *   - "Registry" tab → `GET /api/v1/mcps?scope=public` (live community MCPs)
 *   - "Built-in" tab → `GET /api/mcp/list`            (platform MCPs)
 *
 * Cards open a detail drawer; owner cards get edit/publish/delete + a real
 * connection test. The header CTA registers a new external MCP.
 */

import { Plus, Puzzle, Search, Zap } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { BrandButton } from "../../cloud-ui/components/brand/brand-button";
import { DashboardPageContainer } from "../../cloud-ui/components/layout/dashboard-page";
import { useSetPageHeader } from "../../cloud-ui/components/layout/page-header-context.hooks";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/utils";
import { useCloudT } from "../shell/CloudI18nProvider";
import type { BuiltinMcpDefinition, UserMcpRecord } from "./lib/api-types";
import {
  type McpConnectionTestResult,
  testBuiltinMcpConnection,
} from "./lib/test-connection";
import { useBuiltinMcps, usePublicMcps, useUserMcps } from "./lib/use-mcps";
import { McpDetailDrawer, StatusBadge } from "./McpDetailDrawer";
import { McpEditorDialog } from "./McpEditorDialog";

type McpsTab = "own" | "registry" | "builtin";

export function McpsView() {
  const t = useCloudT();
  const [tab, setTab] = useState<McpsTab>("own");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<UserMcpRecord | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const ownQuery = useUserMcps({ scope: "own" });
  const publicQuery = usePublicMcps();
  const builtinQuery = useBuiltinMcps();

  useSetPageHeader(
    {
      title: t("cloud.mcps.pageTitle", { defaultValue: "MCP Servers" }),
      description: t("cloud.mcps.pageDescription", {
        defaultValue:
          "Register, publish and connect Model Context Protocol servers for your agents.",
      }),
      actions: (
        <BrandButton
          variant="primary"
          size="sm"
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          {t("cloud.mcps.registerCta", { defaultValue: "Register MCP" })}
        </BrandButton>
      ),
    },
    [t],
  );

  const records: UserMcpRecord[] =
    tab === "own"
      ? (ownQuery.data?.mcps ?? [])
      : tab === "registry"
        ? (publicQuery.data?.mcps ?? [])
        : [];

  const builtins: BuiltinMcpDefinition[] =
    tab === "builtin" ? (builtinQuery.data?.mcps ?? []) : [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) set.add(r.category);
    for (const b of builtins) set.add(b.category);
    return ["all", ...[...set].sort()];
  }, [records, builtins]);

  const filteredRecords = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (text: string) =>
      needle === "" || text.toLowerCase().includes(needle);
    return records.filter(
      (r) =>
        (category === "all" || r.category === category) &&
        (matches(r.name) || matches(r.description)),
    );
  }, [records, category, search]);
  const filteredBuiltins = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (text: string) =>
      needle === "" || text.toLowerCase().includes(needle);
    return builtins.filter(
      (b) =>
        (category === "all" || b.category === category) &&
        (matches(b.name) || matches(b.description)),
    );
  }, [builtins, category, search]);

  const handleSelect = useCallback((id: string) => setDetailId(id), []);

  const isLoading =
    (tab === "own" && ownQuery.isLoading) ||
    (tab === "registry" && publicQuery.isLoading) ||
    (tab === "builtin" && builtinQuery.isLoading);

  const tabs: { id: McpsTab; label: string }[] = [
    {
      id: "own",
      label: t("cloud.mcps.tabOwn", { defaultValue: "My MCPs" }),
    },
    {
      id: "registry",
      label: t("cloud.mcps.tabRegistry", { defaultValue: "Registry" }),
    },
    {
      id: "builtin",
      label: t("cloud.mcps.tabBuiltin", { defaultValue: "Built-in" }),
    },
  ];

  return (
    <DashboardPageContainer className="flex flex-col gap-5">
      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tabDef) => (
          <Button
            variant="ghost"
            type="button"
            key={tabDef.id}
            onClick={() => setTab(tabDef.id)}
            className={cn(
              "min-h-touch px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab === tabDef.id
                ? "border-accent text-txt-strong"
                : "border-transparent text-muted hover:text-txt",
            )}
          >
            {tabDef.label}
          </Button>
        ))}
      </div>

      {/* Search + category filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("cloud.mcps.searchPlaceholder", {
              defaultValue: "Search MCPs...",
            })}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {categories.map((cat) => (
            <Button
              variant="ghost"
              type="button"
              key={cat}
              onClick={() => setCategory(cat)}
              className={cn(
                "min-h-touch px-3 text-xs rounded-full border transition-colors capitalize",
                category === cat
                  ? "border-accent/50 bg-accent-subtle text-txt-strong"
                  : "border-border bg-bg-elevated text-muted hover:bg-bg-hover hover:text-txt",
              )}
            >
              {cat}
            </Button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <GridSkeleton />
      ) : tab === "builtin" ? (
        filteredBuiltins.length === 0 ? (
          <EmptyState
            message={t("cloud.mcps.noBuiltin", {
              defaultValue: "No built-in MCPs match your search.",
            })}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {filteredBuiltins.map((b) => (
              <BuiltinCard key={b.id} mcp={b} />
            ))}
          </div>
        )
      ) : filteredRecords.length === 0 ? (
        <EmptyState
          message={
            tab === "own"
              ? t("cloud.mcps.noOwn", {
                  defaultValue: "You haven't registered any MCP servers yet.",
                })
              : t("cloud.mcps.noRegistry", {
                  defaultValue: "No public MCP servers match your search.",
                })
          }
          action={
            tab === "own" ? (
              <BrandButton
                variant="primary"
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setEditorOpen(true);
                }}
              >
                <Plus className="h-4 w-4" />
                {t("cloud.mcps.registerCta", { defaultValue: "Register MCP" })}
              </BrandButton>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filteredRecords.map((mcp) => (
            <UserMcpCard key={mcp.id} mcp={mcp} onSelect={handleSelect} />
          ))}
        </div>
      )}

      <McpEditorDialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) setEditing(null);
        }}
        editing={editing}
      />

      <McpDetailDrawer
        mcpId={detailId}
        onClose={() => setDetailId(null)}
        onEdit={(mcp) => {
          setDetailId(null);
          setEditing(mcp);
          setEditorOpen(true);
        }}
      />
    </DashboardPageContainer>
  );
}

const UserMcpCard = memo(function UserMcpCard({
  mcp,
  onSelect,
}: {
  mcp: UserMcpRecord;
  onSelect: (id: string) => void;
}) {
  const t = useCloudT();
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={() => onSelect(mcp.id)}
      className="group text-left rounded-sm border border-border bg-card p-4 transition-colors hover:border-border-strong hover:bg-bg-hover"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-sm border border-border bg-bg-elevated shrink-0">
            <Puzzle className="h-4 w-4 text-accent" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-txt-strong truncate flex items-center gap-2">
              {mcp.name}
              {mcp.x402_enabled && (
                <Zap className="h-3 w-3 text-accent shrink-0" />
              )}
            </h3>
            <p className="text-xs text-muted">
              v{mcp.version} ·{" "}
              {t("cloud.mcps.toolsCount", {
                defaultValue: "{{n}} tools",
                n: mcp.tools.length,
              })}
            </p>
          </div>
        </div>
        <StatusBadge status={mcp.status} />
      </div>
      <p className="mt-3 text-xs text-muted line-clamp-2 min-h-[2.5rem]">
        {mcp.description}
      </p>
      <div className="mt-3 flex items-center justify-between text-xs text-muted">
        <span className="capitalize">{mcp.category}</span>
        <span className="text-muted group-hover:text-txt-strong transition-colors">
          {t("cloud.mcps.viewDetails", { defaultValue: "View details" })}
        </span>
      </div>
    </Button>
  );
});

const BuiltinCard = memo(function BuiltinCard({
  mcp,
}: {
  mcp: BuiltinMcpDefinition;
}) {
  const t = useCloudT();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<McpConnectionTestResult | null>(null);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    const r = await testBuiltinMcpConnection(mcp.endpoint, mcp.name);
    setResult(r);
    setTesting(false);
  };

  return (
    <div className="rounded-sm border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-sm border border-border bg-bg-elevated shrink-0">
            <Puzzle className="h-4 w-4 text-accent" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-txt-strong truncate">
              {mcp.name}
            </h3>
            <p className="text-xs text-muted">
              v{mcp.version} ·{" "}
              {t("cloud.mcps.toolsCount", {
                defaultValue: "{{n}} tools",
                n: mcp.tools.length,
              })}
            </p>
          </div>
        </div>
        <span className="text-2xs px-1.5 py-0 rounded-full border border-status-success/30 bg-status-success-bg text-status-success capitalize">
          {mcp.status}
        </span>
      </div>
      <p className="mt-3 text-xs text-muted line-clamp-2 min-h-[2.5rem]">
        {mcp.description}
      </p>
      <div className="mt-3 flex items-center justify-between">
        <code className="font-mono text-xs text-muted truncate">
          {mcp.endpoint}
        </code>
        <BrandButton
          variant="outline"
          size="sm"
          onClick={() => void runTest()}
          disabled={testing}
        >
          {testing
            ? t("cloud.mcps.testing", { defaultValue: "Testing..." })
            : t("cloud.mcps.test", { defaultValue: "Test" })}
        </BrandButton>
      </div>
      {result && (
        <pre
          className={cn(
            "mt-3 rounded-sm border p-2 font-mono text-xs-tight max-h-32 overflow-auto",
            result.ok
              ? "border-border bg-bg-elevated text-muted"
              : "border-destructive/30 bg-status-danger-bg text-destructive",
          )}
        >
          {result.summary}
        </pre>
      )}
    </div>
  );
});

function GridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-32 rounded-sm border border-border bg-card animate-pulse motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

function EmptyState({
  message,
  action,
}: {
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-sm border border-border bg-card py-16 text-center">
      <Puzzle className="h-10 w-10 text-muted" />
      <p className="text-sm text-muted">{message}</p>
      {action}
    </div>
  );
}
