/**
 * App permissions settings panel.
 *
 * Lists every registered app and lets the operator toggle which
 * declared permission namespaces are granted. Reads/writes:
 *   GET  /api/apps/permissions
 *   PUT  /api/apps/permissions/:slug   { namespaces: string[] }
 */

import {
  type AppPermissionsView,
  RECOGNISED_PERMISSION_NAMESPACES,
  type RecognisedPermissionNamespace,
} from "@elizaos/shared";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import { useApp } from "../../state";
import { Switch } from "../ui/switch";
import { SettingsActionButton } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

const NAMESPACE_LABELS: Record<RecognisedPermissionNamespace, string> = {
  fs: "Filesystem",
  net: "Network",
};

const NAMESPACE_DESCRIPTIONS: Record<RecognisedPermissionNamespace, string> = {
  fs: "Read/write files the app's manifest declares.",
  net: "Reach the hosts the app's manifest declares.",
};

type AsyncStatus =
  | { state: "idle" }
  | { state: "loading"; message?: string }
  | { state: "error"; message: string };

interface RowState {
  view: AppPermissionsView;
  pending: boolean;
  error: string | null;
}

function buildRowState(view: AppPermissionsView): RowState {
  return { view, pending: false, error: null };
}

function summariseRequested(
  view: AppPermissionsView,
  ns: RecognisedPermissionNamespace,
): string | null {
  const block = view.requestedPermissions?.[ns];
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  if (ns === "fs") {
    const fs = block as { read?: unknown; write?: unknown };
    const read = Array.isArray(fs.read) ? (fs.read as unknown[]) : [];
    const write = Array.isArray(fs.write) ? (fs.write as unknown[]) : [];
    const parts: string[] = [];
    if (read.length > 0)
      parts.push(
        `read: ${read.filter((v) => typeof v === "string").join(", ")}`,
      );
    if (write.length > 0)
      parts.push(
        `write: ${write.filter((v) => typeof v === "string").join(", ")}`,
      );
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  if (ns === "net") {
    const net = block as { outbound?: unknown };
    const outbound = Array.isArray(net.outbound)
      ? (net.outbound as unknown[])
      : [];
    const hosts = outbound.filter((v): v is string => typeof v === "string");
    return hosts.length > 0 ? `outbound: ${hosts.join(", ")}` : null;
  }
  return null;
}

export function AppPermissionsSection() {
  const { setActionNotice } = useApp();
  const [rows, setRows] = useState<RowState[]>([]);
  const [listStatus, setListStatus] = useState<AsyncStatus>({
    state: "loading",
  });
  const mountedRef = useRef(true);
  const rowsRef = useRef<RowState[]>([]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setListStatus({ state: "loading" });
    try {
      const views = await client.listAppPermissions();
      if (!mountedRef.current) return;
      setRows(views.map(buildRowState));
      setListStatus({ state: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!mountedRef.current) return;
      setListStatus({
        state: "error",
        message: `Failed to load app permissions: ${message}`,
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggle = useCallback(
    async (slug: string, ns: RecognisedPermissionNamespace, next: boolean) => {
      const targetRow = rowsRef.current.find((row) => row.view.slug === slug);
      if (!targetRow) return;
      const previousGranted = targetRow.view.grantedNamespaces;
      const nextSet: RecognisedPermissionNamespace[] = next
        ? Array.from(
            new Set<RecognisedPermissionNamespace>([...previousGranted, ns]),
          )
        : previousGranted.filter(
            (existing: RecognisedPermissionNamespace) => existing !== ns,
          );

      // Optimistic flip; reverted on error below.
      setRows((prev) =>
        prev.map((row) =>
          row.view.slug === slug
            ? {
                view: { ...row.view, grantedNamespaces: nextSet },
                pending: true,
                error: null,
              }
            : row,
        ),
      );
      try {
        const updated = await client.setAppPermissions(slug, nextSet);
        if (!mountedRef.current) return;
        setRows((prev) =>
          prev.map((row) =>
            row.view.slug === slug
              ? { view: updated, pending: false, error: null }
              : row,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!mountedRef.current) return;
        setRows((prev) =>
          prev.map((row) =>
            row.view.slug === slug
              ? {
                  view: { ...row.view, grantedNamespaces: previousGranted },
                  pending: false,
                  error: message,
                }
              : row,
          ),
        );
        setActionNotice?.(
          `Failed to update permissions for ${slug}: ${message}`,
          "error",
        );
      }
    },
    [setActionNotice],
  );

  const grantableRows = useMemo(
    () => rows.filter((row) => row.view.recognisedNamespaces.length > 0),
    [rows],
  );

  const noManifestRows = useMemo(
    () => rows.filter((row) => row.view.recognisedNamespaces.length === 0),
    [rows],
  );

  const refreshButton = (
    <SettingsActionButton
      agentId="appperm-refresh"
      agentLabel="Refresh"
      agentDescription="Reload the app permissions list"
      agentGroup="app-permissions"
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void refresh()}
      className="h-9 gap-1.5 rounded-sm px-3 text-xs font-semibold"
      disabled={listStatus.state === "loading"}
    >
      {listStatus.state === "loading" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      Refresh
    </SettingsActionButton>
  );

  return (
    <SettingsStack>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {refreshButton}
      </div>

      {listStatus.state === "error" && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {listStatus.message}
        </div>
      )}

      {listStatus.state !== "loading" && grantableRows.length === 0 && (
        <SettingsGroup bare>
          <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-xs text-muted">
            No apps declare permissions yet.
          </div>
        </SettingsGroup>
      )}

      {grantableRows.map((row) => (
        <SettingsGroup
          key={row.view.slug}
          title={row.view.slug}
          description={
            row.view.trust === "first-party"
              ? "First-party · auto-granted"
              : "External · explicit consent"
          }
          action={
            row.view.grantedAt ? (
              <span className="text-2xs text-muted">
                granted {new Date(row.view.grantedAt).toLocaleDateString()}
              </span>
            ) : undefined
          }
          footer={
            row.error ? (
              <span className="text-danger">{row.error}</span>
            ) : undefined
          }
        >
          {RECOGNISED_PERMISSION_NAMESPACES.map((ns) => {
            if (!row.view.recognisedNamespaces.includes(ns)) return null;
            return (
              <AppPermissionToggle
                key={ns}
                slug={row.view.slug}
                ns={ns}
                granted={row.view.grantedNamespaces.includes(ns)}
                summary={summariseRequested(row.view, ns)}
                disabled={row.pending}
                onToggle={onToggle}
              />
            );
          })}
        </SettingsGroup>
      ))}

      {noManifestRows.length > 0 && (
        <details className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
          <summary className="cursor-pointer">
            {noManifestRows.length} registered app
            {noManifestRows.length === 1 ? "" : "s"} without a permissions
            manifest
          </summary>
          <ul className="mt-1.5 space-y-0.5 pl-4">
            {noManifestRows.map((row) => (
              <li key={row.view.slug} className="list-disc">
                {row.view.slug}
              </li>
            ))}
          </ul>
        </details>
      )}
    </SettingsStack>
  );
}

function AppPermissionToggle({
  slug,
  ns,
  granted,
  summary,
  disabled,
  onToggle,
}: {
  slug: string;
  ns: RecognisedPermissionNamespace;
  granted: boolean;
  summary: string | null;
  disabled: boolean;
  onToggle: (
    slug: string,
    ns: RecognisedPermissionNamespace,
    next: boolean,
  ) => void;
}) {
  const toggleId = `appperm-${slug}-${ns}`;
  const label = `Toggle ${NAMESPACE_LABELS[ns]} for ${slug}`;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: toggleId,
    role: "toggle",
    label,
    group: "app-permissions",
    description: NAMESPACE_DESCRIPTIONS[ns],
    status: granted ? "on" : "off",
    getValue: () => granted,
    onActivate: disabled ? undefined : () => onToggle(slug, ns, !granted),
  });
  return (
    <SettingsRow
      htmlFor={toggleId}
      label={NAMESPACE_LABELS[ns]}
      description={
        <>
          {NAMESPACE_DESCRIPTIONS[ns]}
          {summary ? (
            <span className="mt-1 block truncate font-mono text-xs text-txt">
              {summary}
            </span>
          ) : null}
        </>
      }
      control={
        <Switch
          ref={ref}
          id={toggleId}
          checked={granted}
          disabled={disabled}
          onCheckedChange={(checked) => onToggle(slug, ns, checked)}
          aria-label={label}
          {...agentProps}
        />
      }
    />
  );
}
