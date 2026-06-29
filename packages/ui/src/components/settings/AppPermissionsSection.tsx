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
  parseAppPermissions,
  RECOGNISED_PERMISSION_NAMESPACES,
  type RecognisedPermissionNamespace,
} from "@elizaos/shared";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import { useAppSelector } from "../../state";
import { Switch } from "../ui/switch";
import { SettingsActionButton } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

const NAMESPACE_LABELS: Record<RecognisedPermissionNamespace, string> = {
  fs: "Filesystem",
  net: "Network",
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
  // Parse through the canonical manifest parser so the read fields are strongly
  // typed (`string[]`) instead of hand-narrowed `unknown` casts.
  const parsed = parseAppPermissions(view.requestedPermissions);
  if (parsed.ok === false) return null;
  if (ns === "fs") {
    const fs = parsed.manifest.fs;
    if (!fs) return null;
    const parts: string[] = [];
    if (fs.read && fs.read.length > 0)
      parts.push(`read: ${fs.read.join(", ")}`);
    if (fs.write && fs.write.length > 0)
      parts.push(`write: ${fs.write.join(", ")}`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  if (ns === "net") {
    const outbound = parsed.manifest.net?.outbound;
    return outbound && outbound.length > 0
      ? `outbound: ${outbound.join(", ")}`
      : null;
  }
  return null;
}

export function AppPermissionsSection() {
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
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
        <p className="text-xs text-danger">{listStatus.message}</p>
      )}

      {listStatus.state !== "loading" && grantableRows.length === 0 && (
        <p className="py-6 text-center text-xs text-muted">
          No apps declare permissions yet.
        </p>
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
                granted{" "}
                {new Date(row.view.grantedAt).toLocaleDateString("en-US")}
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
        <details className="text-xs text-muted">
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
    status: granted ? "on" : "off",
    getValue: () => granted,
    onActivate: disabled ? undefined : () => onToggle(slug, ns, !granted),
  });
  return (
    <SettingsRow
      htmlFor={toggleId}
      label={NAMESPACE_LABELS[ns]}
      description={
        summary ? (
          <span className="block truncate font-mono text-xs text-txt">
            {summary}
          </span>
        ) : undefined
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
