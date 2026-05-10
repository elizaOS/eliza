/**
 * App permissions settings panel.
 *
 * Lists every registered app and lets the operator toggle which
 * declared permission namespaces are granted. Reads/writes:
 *   GET  /api/apps/permissions
 *   PUT  /api/apps/permissions/:slug   { namespaces: string[] }
 *
 * Per `eliza/packages/docs/architecture/app-permissions-granted-store.md`
 * grants are advisory in this slice — Phase 2 wires the runtime
 * enforcement that reads them. The UI surfaces this as a "not yet
 * enforced" badge so users aren't misled.
 */

import {
  type AppPermissionsView,
  RECOGNISED_PERMISSION_NAMESPACES,
  type RecognisedPermissionNamespace,
} from "@elizaos/shared/contracts/app-permissions";
import { Switch } from "@elizaos/ui";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../api/client";
import { useApp } from "../../state";

const NAMESPACE_LABELS: Record<RecognisedPermissionNamespace, string> = {
  fs: "Filesystem",
  net: "Network",
};

const NAMESPACE_DESCRIPTIONS: Record<RecognisedPermissionNamespace, string> = {
  fs: "Read and write files within the patterns the app declared in its manifest.",
  net: "Make outbound network requests to the hosts the app declared in its manifest.",
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

      // Optimistically flip the granted set so the Switch snaps to the
      // new position immediately. Reverted on error below.
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
        // Revert the optimistic flip.
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

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs-tight text-muted">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          <span>
            Grants are recorded but not yet enforced. Enforcement lands in a
            future release.
          </span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-bg-hover px-2.5 py-1 text-xs-tight text-muted-strong hover:bg-bg-hover/80"
          disabled={listStatus.state === "loading"}
        >
          {listStatus.state === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Refresh
        </button>
      </header>

      {listStatus.state === "error" && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {listStatus.message}
        </div>
      )}

      {listStatus.state !== "loading" && grantableRows.length === 0 && (
        <div className="rounded-xl border border-border/60 bg-card/92 px-4 py-6 text-center text-xs-tight text-muted">
          No registered apps declare permissions yet. Apps loaded via
          <code className="mx-1 rounded bg-bg-hover px-1 py-0.5 font-mono text-2xs">
            APP load_from_directory
          </code>
          that include an
          <code className="mx-1 rounded bg-bg-hover px-1 py-0.5 font-mono text-2xs">
            elizaos.app.permissions
          </code>
          block will appear here.
        </div>
      )}

      {grantableRows.map((row) => (
        <article
          key={row.view.slug}
          className="space-y-3 rounded-2xl border border-border/60 bg-card/92 p-4 shadow-sm"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-semibold text-sm text-txt">
                {row.view.slug}
              </h3>
              <p className="text-2xs uppercase tracking-wider text-muted">
                {row.view.trust === "first-party"
                  ? "First-party · auto-granted"
                  : "External · explicit consent"}
              </p>
            </div>
            {row.view.grantedAt && (
              <span className="text-2xs text-muted">
                granted {new Date(row.view.grantedAt).toLocaleDateString()}
              </span>
            )}
          </header>

          <div className="space-y-2">
            {RECOGNISED_PERMISSION_NAMESPACES.map((ns) => {
              if (!row.view.recognisedNamespaces.includes(ns)) return null;
              const granted = row.view.grantedNamespaces.includes(ns);
              const summary = summariseRequested(row.view, ns);
              const toggleId = `app-perm-${row.view.slug}-${ns}`;
              return (
                <div
                  key={ns}
                  className={`flex flex-col gap-2 rounded-xl border px-3 py-2 sm:flex-row sm:items-center ${
                    granted
                      ? "border-accent/30 bg-accent/10"
                      : "border-border/60 bg-bg-hover"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <label
                      htmlFor={toggleId}
                      className="font-medium text-sm text-txt"
                    >
                      {NAMESPACE_LABELS[ns]}
                    </label>
                    <p className="mt-0.5 text-2xs leading-4 text-muted">
                      {NAMESPACE_DESCRIPTIONS[ns]}
                    </p>
                    {summary && (
                      <p className="mt-1 truncate font-mono text-2xs text-muted-strong">
                        {summary}
                      </p>
                    )}
                  </div>
                  <Switch
                    id={toggleId}
                    checked={granted}
                    disabled={row.pending}
                    onCheckedChange={(checked) =>
                      void onToggle(row.view.slug, ns, checked)
                    }
                    aria-label={`Toggle ${NAMESPACE_LABELS[ns]} for ${row.view.slug}`}
                  />
                </div>
              );
            })}
          </div>

          {row.error && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-2xs text-danger">
              {row.error}
            </div>
          )}
        </article>
      ))}

      {noManifestRows.length > 0 && (
        <details className="rounded-xl border border-border/60 bg-bg-hover/40 px-3 py-2 text-xs-tight text-muted">
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
    </div>
  );
}
