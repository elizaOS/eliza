/**
 * Vault inventory panel — shows every secret stored, grouped by category,
 * with reveal / edit / delete and per-key profile management.
 *
 * Endpoints driven:
 *   GET    /api/secrets/inventory                       (load list)
 *   GET    /api/secrets/inventory/:key                  (reveal, on demand)
 *   PUT    /api/secrets/inventory/:key                  (add or replace)
 *   DELETE /api/secrets/inventory/:key                  (drop)
 *   GET    /api/secrets/inventory/:key/profiles         (profile list)
 *   POST   /api/secrets/inventory/:key/profiles         (add)
 *   PATCH  /api/secrets/inventory/:key/profiles/:id     (update)
 *   DELETE /api/secrets/inventory/:key/profiles/:id     (drop)
 *   PUT    /api/secrets/inventory/:key/active-profile   (switch active)
 *   POST   /api/secrets/inventory/migrate-to-profiles   (opt-in promotion)
 *
 * Routing rules live in a sibling tab (`RoutingTab`); the per-key
 * "Routing rules for this profile →" affordance hands control back to
 * the Vault modal via `onJumpToRouting`.
 *
 * Hard rule: revealed values never persist in component state past the
 * 10-second auto-hide window.
 */

import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
// All requests go through the shared client (never bare `fetch`) so they hit
// the configured apiBase and carry the injected auth token — a bare relative
// fetch targets the page origin unauthenticated, which breaks remote/token-
// authed runtimes (e.g. the Android local agent).
import { client } from "../../api/client";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectValue } from "../ui/select";
import { SettingsSelectTrigger } from "../ui/settings-controls";
import type { VaultEntryCategory, VaultEntryMeta } from "./vault-tabs/types";

const CATEGORY_LABEL: Record<VaultEntryCategory, string> = {
  provider: "Providers",
  plugin: "Plugins",
  wallet: "Wallet",
  credential: "Saved logins",
  session: "Sessions",
  system: "System",
};

const CATEGORY_ORDER: VaultEntryCategory[] = [
  "provider",
  "plugin",
  "wallet",
  "credential",
  "session",
  "system",
];

const CATEGORY_INPUT_OPTIONS: Array<{
  value: VaultEntryCategory;
  labelKey: string;
  defaultLabel: string;
}> = [
  {
    value: "provider",
    labelKey: "vaultinventory.category.provider",
    defaultLabel: "Provider",
  },
  {
    value: "plugin",
    labelKey: "vaultinventory.category.plugin",
    defaultLabel: "Plugin",
  },
  {
    value: "wallet",
    labelKey: "vaultinventory.category.wallet",
    defaultLabel: "Wallet",
  },
  {
    value: "credential",
    labelKey: "vaultinventory.category.credential",
    defaultLabel: "Saved login",
  },
  {
    value: "session",
    labelKey: "vaultinventory.category.session",
    defaultLabel: "Session",
  },
  {
    value: "system",
    labelKey: "vaultinventory.category.system",
    defaultLabel: "System",
  },
];

// ── Public component ───────────────────────────────────────────────

export interface VaultInventoryPanelProps {
  /**
   * Pre-fetched entries owned by the parent tab. When provided, the
   * panel skips its internal load and delegates the refresh callback
   * upward via `onChanged`.
   */
  entries?: VaultEntryMeta[];
  /**
   * When the parent owns the data, this callback is invoked after every
   * mutation so the modal can re-fetch and propagate the new list to
   * sibling tabs.
   */
  onChanged?: () => void;
  /**
   * Cross-tab jump handler. When a row's "Routing rules for this
   * profile →" button is clicked, the panel calls this with the row's
   * key so the Vault modal can switch to the Routing tab pre-filtered.
   */
  onJumpToRouting?: (key: string) => void;
  /**
   * Optional row to focus when the panel mounts. Used by cross-tab
   * jumps from the Routing tab. The panel scrolls the row into view
   * and expands its profile panel, then clears the focus via
   * `onFocusApplied`.
   */
  focusKey?: string | null;
  /** Optional profile id to highlight inside the focused row. */
  focusProfileId?: string | null;
  /**
   * Called after the panel has applied the focus so the parent can
   * reset its focus state. Without this the panel would re-apply on
   * every parent re-render.
   */
  onFocusApplied?: () => void;
}

export function VaultInventoryPanel(props: VaultInventoryPanelProps = {}) {
  const { t } = useTranslation();
  const { ref: addSecretRef, agentProps: addSecretAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "vault-add-secret",
      role: "button",
      label: "Add secret",
      group: "vault-inventory",
      description: "Show the form to add a new vault secret",
    });
  const {
    entries: externalEntries,
    onChanged: externalOnChanged,
    onJumpToRouting,
    focusKey,
    focusProfileId,
    onFocusApplied,
  } = props;
  const ownsData = externalEntries === undefined;
  const [internalEntries, setInternalEntries] = useState<
    VaultEntryMeta[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await client.rawRequest("/api/secrets/inventory", undefined, {
        allowNonOk: true,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { entries: VaultEntryMeta[] };
      setInternalEntries(body.entries);
    } catch (err) {
      // Boundary translation: surface fetch / parse errors to the panel
      // banner so the modal stays usable (other tabs can still load).
      setError(err instanceof Error ? err.message : "load failed");
      setInternalEntries([]);
    }
  }, []);

  useEffect(() => {
    if (!ownsData) return;
    void load();
  }, [load, ownsData]);

  const onChanged = useCallback(() => {
    if (externalOnChanged) externalOnChanged();
    else void load();
  }, [externalOnChanged, load]);

  const entries = ownsData ? internalEntries : (externalEntries ?? []);

  const grouped = useMemo(() => {
    const buckets: Record<VaultEntryCategory, VaultEntryMeta[]> = {
      provider: [],
      plugin: [],
      wallet: [],
      credential: [],
      session: [],
      system: [],
    };
    for (const e of entries ?? []) {
      const bucket = buckets[e.category];
      if (bucket) bucket.push(e);
    }
    return buckets;
  }, [entries]);

  return (
    <section data-testid="vault-inventory-panel" className="space-y-2 pt-1">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-sm font-medium text-txt">
          {t("vaultinventory.storedSecrets", {
            defaultValue: "Stored secrets",
          })}
        </p>
        <Button
          ref={addSecretRef}
          {...addSecretAgentProps}
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1 rounded-sm px-2"
          onClick={() => setShowAdd((v) => !v)}
          aria-label={t("vaultinventory.addSecret", {
            defaultValue: "Add secret",
          })}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("vaultinventory.addSecret", { defaultValue: "Add secret" })}
        </Button>
      </div>

      {error && (
        <div
          aria-live="polite"
          data-testid="vault-inventory-error"
          className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger"
        >
          {error}
        </div>
      )}

      {showAdd && (
        <AddSecretForm
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            onChanged();
          }}
        />
      )}

      {entries === null ? (
        <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading…
        </div>
      ) : entries.length === 0 ? (
        <p
          data-testid="vault-inventory-empty"
          className="px-3 py-3 text-center text-xs text-muted"
        >
          No secrets yet.
        </p>
      ) : (
        <div className="space-y-3">
          {CATEGORY_ORDER.map((cat) => {
            const rows = grouped[cat];
            if (rows.length === 0) return null;
            return (
              <CategoryGroup
                key={cat}
                category={cat}
                entries={rows}
                onChanged={onChanged}
                onJumpToRouting={onJumpToRouting}
                focusKey={focusKey ?? null}
                focusProfileId={focusProfileId ?? null}
                onFocusApplied={onFocusApplied}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Category group ─────────────────────────────────────────────────

const CategoryGroup = memo(function CategoryGroup({
  category,
  entries,
  onChanged,
  onJumpToRouting,
  focusKey,
  focusProfileId,
  onFocusApplied,
}: {
  category: VaultEntryCategory;
  entries: VaultEntryMeta[];
  onChanged: () => void;
  onJumpToRouting?: (key: string) => void;
  focusKey: string | null;
  focusProfileId: string | null;
  onFocusApplied?: () => void;
}) {
  return (
    <div data-testid={`vault-category-${category}`} className="space-y-1">
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted/70">
        {CATEGORY_LABEL[category]}
      </p>
      <ul className="space-y-1">
        {entries.map((entry) => (
          <li key={entry.key}>
            <EntryRow
              entry={entry}
              onChanged={onChanged}
              onJumpToRouting={onJumpToRouting}
              focusKey={focusKey}
              focusProfileId={focusProfileId}
              onFocusApplied={onFocusApplied}
            />
          </li>
        ))}
      </ul>
    </div>
  );
});

// ── Single entry row ───────────────────────────────────────────────

const EntryRow = memo(function EntryRow({
  entry,
  onChanged,
  onJumpToRouting,
  focusKey,
  focusProfileId,
  onFocusApplied,
}: {
  entry: VaultEntryMeta;
  onChanged: () => void;
  onJumpToRouting?: (key: string) => void;
  focusKey: string | null;
  focusProfileId: string | null;
  onFocusApplied?: () => void;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState<{
    value: string;
    source: string;
    profileId?: string;
  } | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const { ref: revealRef, agentProps: revealAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-entry-reveal-${entry.key}`,
      role: "button",
      label: `${revealed ? "Hide" : "Reveal"} ${entry.label}`,
      group: "vault-inventory",
      description: `Reveal or hide the stored value for ${entry.key}`,
      status: revealed ? "active" : "inactive",
    });
  const { ref: deleteRef, agentProps: deleteAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-entry-delete-${entry.key}`,
      role: "button",
      label: `Delete ${entry.label}`,
      group: "vault-inventory",
      description: `Delete the stored secret ${entry.key}`,
    });

  // Apply incoming focus once: expand and scroll into view.
  useEffect(() => {
    if (focusKey !== entry.key) return;
    setExpanded(true);
    // jsdom doesn't define `scrollIntoView`, so guard before calling.
    if (rowRef.current && typeof rowRef.current.scrollIntoView === "function") {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (onFocusApplied) {
      // Defer to allow scroll-into-view to settle visually before the
      // parent clears the focus state and re-renders.
      const id = window.setTimeout(onFocusApplied, 250);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [focusKey, entry.key, onFocusApplied]);

  // Auto-hide the revealed value after 10 seconds.
  useEffect(() => {
    if (!revealed) return;
    const id = setTimeout(() => setRevealed(null), 10_000);
    return () => clearTimeout(id);
  }, [revealed]);

  const reveal = useCallback(async () => {
    setRevealing(true);
    setRevealError(null);
    const res = await client.rawRequest(
      `/api/secrets/inventory/${encodeURIComponent(entry.key)}`,
      undefined,
      { allowNonOk: true },
    );
    if (!res.ok) {
      setRevealError(`HTTP ${res.status}`);
      setRevealing(false);
      return;
    }
    const body = (await res.json()) as {
      value: string;
      source: string;
      profileId?: string;
    };
    setRevealed(body);
    setRevealing(false);
  }, [entry.key]);

  const hide = useCallback(() => setRevealed(null), []);

  const copy = useCallback(async () => {
    if (!revealed) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(revealed.value);
    }
  }, [revealed]);

  const onDelete = useCallback(async () => {
    const confirmed = window.confirm(
      `Delete "${entry.label}"? This drops the value, every profile, and the metadata.`,
    );
    if (!confirmed) return;
    const res = await client.rawRequest(
      `/api/secrets/inventory/${encodeURIComponent(entry.key)}`,
      { method: "DELETE" },
      { allowNonOk: true },
    );
    if (res.ok) onChanged();
  }, [entry.key, entry.label, onChanged]);

  const profileCount = entry.profiles?.length ?? 0;

  return (
    <div
      ref={rowRef}
      data-testid={`vault-entry-row-${entry.key}`}
      className="rounded-sm px-2 py-1.5 hover:bg-bg-muted/30"
    >
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 rounded-sm p-0 text-muted"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-txt">{entry.label}</p>
          <p className="truncate font-mono text-2xs text-muted">{entry.key}</p>
        </div>
        {profileCount > 0 && (
          <span
            data-testid={`profile-badge-${entry.key}`}
            className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent"
          >
            {profileCount} profile{profileCount === 1 ? "" : "s"}
          </span>
        )}
        {!revealed ? (
          <Button
            ref={revealRef}
            {...revealAgentProps}
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 rounded-sm px-2 text-xs text-muted"
            onClick={() => void reveal()}
            disabled={revealing}
            aria-label={`Reveal ${entry.label}`}
          >
            {revealing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Eye className="h-3.5 w-3.5" aria-hidden />
            )}
            Reveal
          </Button>
        ) : (
          <Button
            ref={revealRef}
            {...revealAgentProps}
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 rounded-sm px-2 text-xs text-muted"
            onClick={hide}
            aria-label={`Hide ${entry.label}`}
          >
            <EyeOff className="h-3.5 w-3.5" aria-hidden />
            Hide
          </Button>
        )}
        <Button
          ref={deleteRef}
          {...deleteAgentProps}
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 rounded-sm p-0 text-muted hover:text-danger"
          onClick={() => void onDelete()}
          aria-label={`Delete ${entry.label}`}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      {revealed && (
        <div
          data-testid={`vault-revealed-${entry.key}`}
          className="mt-1.5 flex items-center gap-2 rounded-sm border border-border/50 bg-bg/40 p-2"
        >
          <code className="flex-1 truncate font-mono text-2xs text-txt">
            {revealed.value}
          </code>
          {revealed.source === "profile" && revealed.profileId && (
            <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs text-accent">
              {revealed.profileId}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 rounded-sm px-2 text-2xs"
            onClick={() => void copy()}
            aria-label={t("vaultinventory.copy", { defaultValue: "Copy" })}
          >
            <Copy className="h-3 w-3" aria-hidden />{" "}
            {t("vaultinventory.copy", { defaultValue: "Copy" })}
          </Button>
        </div>
      )}

      {revealError && (
        <p className="mt-1 text-2xs text-danger">{revealError}</p>
      )}

      {expanded && (
        <ProfilesPanel
          entry={entry}
          onChanged={onChanged}
          onJumpToRouting={onJumpToRouting}
          highlightProfileId={focusKey === entry.key ? focusProfileId : null}
        />
      )}
    </div>
  );
});

// ── Profiles management ────────────────────────────────────────────

function ProfilesPanel({
  entry,
  onChanged,
  onJumpToRouting,
  highlightProfileId,
}: {
  entry: VaultEntryMeta;
  onChanged: () => void;
  onJumpToRouting?: (key: string) => void;
  highlightProfileId: string | null;
}) {
  const { t } = useTranslation();
  const [showAdd, setShowAdd] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);

  const profiles = entry.profiles ?? [];
  const hasProfiles = profiles.length > 0;

  const { ref: jumpRoutingRef, agentProps: jumpRoutingAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-profile-routing-${entry.key}`,
      role: "button",
      label: `Routing rules for ${entry.label}`,
      group: "vault-profiles",
      description: `Open the Routing tab pre-filtered to ${entry.key}`,
    });
  const { ref: profileAddRef, agentProps: profileAddAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-profile-add-${entry.key}`,
      role: "button",
      label: hasProfiles
        ? `Add profile to ${entry.label}`
        : `Enable profiles for ${entry.label}`,
      group: "vault-profiles",
      description: hasProfiles
        ? "Show the add-profile form"
        : "Promote this key to support multiple profiles",
    });
  const { ref: newIdRef, agentProps: newIdAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `vault-profile-id-${entry.key}`,
      role: "text-input",
      label: "New profile id",
      group: "vault-profiles",
      getValue: () => newId,
      onFill: (v) => setNewId(v),
    });
  const { ref: newLabelRef, agentProps: newLabelAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `vault-profile-label-${entry.key}`,
      role: "text-input",
      label: "New profile display label",
      group: "vault-profiles",
      getValue: () => newLabel,
      onFill: (v) => setNewLabel(v),
    });
  const { ref: newValueRef, agentProps: newValueAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `vault-profile-value-${entry.key}`,
      role: "text-input",
      label: "New profile value",
      group: "vault-profiles",
      getValue: () => newValue,
      onFill: (v) => setNewValue(v),
    });
  const { ref: profileCancelRef, agentProps: profileCancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-profile-cancel-${entry.key}`,
      role: "button",
      label: "Cancel adding profile",
      group: "vault-profiles",
      onActivate: () => setShowAdd(false),
    });
  const { ref: profileSaveRef, agentProps: profileSaveAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-profile-save-${entry.key}`,
      role: "button",
      label: "Save profile",
      group: "vault-profiles",
    });

  const onAdd = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!newId || !newValue) return;
      setSubmitting(true);
      setErr(null);
      const res = await client.rawRequest(
        `/api/secrets/inventory/${encodeURIComponent(entry.key)}/profiles`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: newId,
            label: newLabel || newId,
            value: newValue,
          }),
        },
        { allowNonOk: true },
      );
      setSubmitting(false);
      if (!res.ok) {
        setErr(`HTTP ${res.status}`);
        return;
      }
      setNewId("");
      setNewLabel("");
      setNewValue("");
      setShowAdd(false);
      onChanged();
    },
    [entry.key, newId, newLabel, newValue, onChanged],
  );

  const onActivate = useCallback(
    async (profileId: string) => {
      const res = await client.rawRequest(
        `/api/secrets/inventory/${encodeURIComponent(entry.key)}/active-profile`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profileId }),
        },
        { allowNonOk: true },
      );
      if (res.ok) onChanged();
    },
    [entry.key, onChanged],
  );

  const onDelete = useCallback(
    async (profileId: string) => {
      const confirmed = window.confirm(`Delete profile "${profileId}"?`);
      if (!confirmed) return;
      const res = await client.rawRequest(
        `/api/secrets/inventory/${encodeURIComponent(entry.key)}/profiles/${encodeURIComponent(profileId)}`,
        { method: "DELETE" },
        { allowNonOk: true },
      );
      if (res.ok) onChanged();
    },
    [entry.key, onChanged],
  );

  const onMigrate = useCallback(async () => {
    setMigrating(true);
    setErr(null);
    const res = await client.rawRequest(
      "/api/secrets/inventory/migrate-to-profiles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: entry.key }),
      },
      { allowNonOk: true },
    );
    setMigrating(false);
    if (!res.ok) {
      setErr(`HTTP ${res.status}`);
      return;
    }
    onChanged();
  }, [entry.key, onChanged]);

  return (
    <div
      data-testid={`profiles-panel-${entry.key}`}
      className="mt-2 space-y-2 border-l-2 border-border/40 pl-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs font-semibold text-muted">
          {t("vaultinventory.profiles.title", { defaultValue: "Profiles" })}
        </p>
        <div className="flex items-center gap-1">
          {hasProfiles && onJumpToRouting && (
            <Button
              ref={jumpRoutingRef}
              {...jumpRoutingAgentProps}
              variant="ghost"
              size="sm"
              className="h-6 gap-1 rounded-sm px-2 text-2xs"
              onClick={() => onJumpToRouting(entry.key)}
              aria-label={t("vaultinventory.profiles.routingRulesFor", {
                label: entry.label,
                defaultValue: "Routing rules for {{label}}",
              })}
            >
              {t("vaultinventory.profiles.routingRules", {
                defaultValue: "Routing rules for this profile",
              })}
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Button>
          )}
          {hasProfiles ? (
            <Button
              ref={profileAddRef}
              {...profileAddAgentProps}
              variant="ghost"
              size="sm"
              className="h-6 gap-1 rounded-sm px-2 text-2xs"
              onClick={() => setShowAdd((v) => !v)}
              aria-label={t("vaultinventory.profiles.addProfile", {
                defaultValue: "Add profile",
              })}
            >
              <Plus className="h-3 w-3" aria-hidden />{" "}
              {t("vaultinventory.profiles.addProfile", {
                defaultValue: "Add profile",
              })}
            </Button>
          ) : (
            <Button
              ref={profileAddRef}
              {...profileAddAgentProps}
              variant="outline"
              size="sm"
              className="h-6 gap-1 rounded-sm px-2 text-2xs"
              onClick={() => void onMigrate()}
              disabled={migrating}
              aria-label={t("vaultinventory.profiles.enableForKey", {
                defaultValue: "Enable profiles for this key",
              })}
            >
              {migrating ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-3 w-3" aria-hidden />
              )}
              {t("vaultinventory.profiles.enable", {
                defaultValue: "Enable profiles",
              })}
            </Button>
          )}
        </div>
      </div>

      {err && (
        <p className="text-2xs text-danger" aria-live="polite">
          {err}
        </p>
      )}

      {hasProfiles && (
        <ul className="space-y-1">
          {profiles.map((p) => (
            <ProfileRow
              key={p.id}
              entryKey={entry.key}
              profileId={p.id}
              profileLabel={p.label}
              active={entry.activeProfile === p.id}
              highlight={highlightProfileId === p.id}
              onActivate={() => void onActivate(p.id)}
              onDelete={() => void onDelete(p.id)}
            />
          ))}
        </ul>
      )}

      {showAdd && (
        <form
          onSubmit={onAdd}
          data-testid={`add-profile-form-${entry.key}`}
          className="space-y-1.5 border-l-2 border-border/40 pl-3"
        >
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            <div>
              <Label className="text-2xs text-muted">
                {t("vaultinventory.profiles.idLabel", {
                  defaultValue: "Profile id",
                })}
              </Label>
              <Input
                ref={newIdRef}
                {...newIdAgentProps}
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder={t("vaultinventory.profiles.idPlaceholder", {
                  defaultValue: "work",
                })}
                className="h-7 text-xs"
                pattern="[A-Za-z0-9_-]+"
                required
              />
            </div>
            <div>
              <Label className="text-2xs text-muted">
                {t("vaultinventory.profiles.labelLabel", {
                  defaultValue: "Display label",
                })}
              </Label>
              <Input
                ref={newLabelRef}
                {...newLabelAgentProps}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t("vaultinventory.profiles.labelPlaceholder", {
                  defaultValue: "Work",
                })}
                className="h-7 text-xs"
              />
            </div>
          </div>
          <div>
            <Label className="text-2xs text-muted">
              {t("vaultinventory.profiles.valueLabel", {
                defaultValue: "Value",
              })}
            </Label>
            <Input
              ref={newValueRef}
              {...newValueAgentProps}
              type="password"
              autoComplete="off"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              className="h-7 font-mono text-xs"
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              ref={profileCancelRef}
              {...profileCancelAgentProps}
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 rounded-sm px-2 text-2xs"
              onClick={() => setShowAdd(false)}
              disabled={submitting}
            >
              {t("vaultinventory.profiles.cancel", {
                defaultValue: "Cancel",
              })}
            </Button>
            <Button
              ref={profileSaveRef}
              {...profileSaveAgentProps}
              type="submit"
              variant="default"
              size="sm"
              className="h-6 rounded-sm px-2 text-2xs"
              disabled={submitting || !newId || !newValue}
            >
              {submitting
                ? t("vaultinventory.profiles.saving", {
                    defaultValue: "Saving…",
                  })
                : t("vaultinventory.profiles.saveProfile", {
                    defaultValue: "Save profile",
                  })}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Single profile row ─────────────────────────────────────────────

interface ProfileRowProps {
  entryKey: string;
  profileId: string;
  profileLabel: string;
  active: boolean;
  highlight: boolean;
  onActivate: () => void;
  onDelete: () => void;
}

const ProfileRow = memo(
  function ProfileRow({
    entryKey,
    profileId,
    profileLabel,
    active,
    highlight,
    onActivate,
    onDelete,
  }: ProfileRowProps) {
    const { t } = useTranslation();
    const { ref: activateRef, agentProps: activateAgentProps } =
      useAgentElement<HTMLInputElement>({
        id: `vault-profile-activate-${entryKey}-${profileId}`,
        role: "toggle",
        label: `Make ${profileLabel} the active profile`,
        group: "vault-profiles",
        status: active ? "active" : "inactive",
        onActivate,
      });
    const { ref: deleteRef, agentProps: deleteAgentProps } =
      useAgentElement<HTMLButtonElement>({
        id: `vault-profile-delete-${entryKey}-${profileId}`,
        role: "button",
        label: `Delete profile ${profileLabel}`,
        group: "vault-profiles",
        onActivate: onDelete,
      });
    return (
      <li
        className={`flex items-center gap-2 rounded-sm px-1.5 py-1 text-xs ${highlight ? " " : ""}`}
      >
        <Input
          ref={activateRef}
          {...activateAgentProps}
          type="radio"
          name={`active-${entryKey}`}
          checked={active}
          onChange={onActivate}
          className="h-3 w-3 cursor-pointer border-border p-0 accent-accent"
          aria-current={active ? "true" : undefined}
          aria-label={t("vaultinventory.profiles.makeActive", {
            label: profileLabel,
            defaultValue: "Make {{label}} active",
          })}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-txt">{profileLabel}</p>
          <p className="truncate font-mono text-2xs text-muted">{profileId}</p>
        </div>
        {active && (
          <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent">
            <CheckCircle2 className="h-3 w-3" aria-hidden />{" "}
            {t("vaultinventory.profiles.active", {
              defaultValue: "Active",
            })}
          </span>
        )}
        <Button
          ref={deleteRef}
          {...deleteAgentProps}
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 rounded-sm p-0 text-muted hover:text-danger"
          aria-label={t("vaultinventory.profiles.deleteProfile", {
            label: profileLabel,
            defaultValue: "Delete profile {{label}}",
          })}
          onClick={onDelete}
        >
          <Trash2 className="h-3 w-3" aria-hidden />
        </Button>
      </li>
    );
  },
  // onActivate/onDelete are allocated inline per row but always act on this
  // row's profileId, so compare only the render-affecting primitive props.
  (prev, next) =>
    prev.entryKey === next.entryKey &&
    prev.profileId === next.profileId &&
    prev.profileLabel === next.profileLabel &&
    prev.active === next.active &&
    prev.highlight === next.highlight,
);

// ── Add-secret form ────────────────────────────────────────────────

function AddSecretForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [providerId, setProviderId] = useState("");
  const [category, setCategory] = useState<VaultEntryCategory>("plugin");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { ref: keyRef, agentProps: keyAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "vault-add-key",
      role: "text-input",
      label: "Secret key",
      group: "vault-add-secret",
      description: "Env-var-style identifier for the secret",
      getValue: () => key,
      onFill: (v) => setKey(v),
    });
  const { ref: labelRef, agentProps: labelAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "vault-add-label",
      role: "text-input",
      label: "Secret display label",
      group: "vault-add-secret",
      getValue: () => label,
      onFill: (v) => setLabel(v),
    });
  const { ref: valueRef, agentProps: valueAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "vault-add-value",
      role: "text-input",
      label: "Secret value",
      group: "vault-add-secret",
      description: "The value plugins read at runtime",
      getValue: () => value,
      onFill: (v) => setValue(v),
    });
  const { ref: categoryRef, agentProps: categoryAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "vault-add-category",
      role: "select",
      label: "Secret category",
      group: "vault-add-secret",
      options: CATEGORY_INPUT_OPTIONS.map((opt) => opt.value),
      getValue: () => category,
      onFill: (v) => setCategory(v as VaultEntryCategory),
    });
  const { ref: providerRef, agentProps: providerAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "vault-add-provider-id",
      role: "text-input",
      label: "Secret provider id",
      group: "vault-add-secret",
      getValue: () => providerId,
      onFill: (v) => setProviderId(v),
    });
  const { ref: cancelRef, agentProps: cancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "vault-add-cancel",
      role: "button",
      label: "Cancel adding secret",
      group: "vault-add-secret",
      onActivate: onClose,
    });
  const { ref: saveRef, agentProps: saveAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "vault-add-save",
      role: "button",
      label: "Save secret",
      group: "vault-add-secret",
      description: "Save the new secret to the vault",
    });

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!key.trim() || !value) return;
      setSubmitting(true);
      setErr(null);
      const res = await client.rawRequest(
        `/api/secrets/inventory/${encodeURIComponent(key.trim())}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value,
            ...(label.trim() ? { label: label.trim() } : {}),
            ...(providerId.trim() ? { providerId: providerId.trim() } : {}),
            category,
          }),
        },
        { allowNonOk: true },
      );
      setSubmitting(false);
      if (!res.ok) {
        setErr(`HTTP ${res.status}`);
        return;
      }
      onSaved();
    },
    [category, key, label, providerId, value, onSaved],
  );

  return (
    <form
      onSubmit={onSubmit}
      data-testid="vault-add-secret-form"
      className="space-y-2 border-l-2 border-border/50 pl-3"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <Label className="text-2xs text-muted">
            {t("vaultinventory.addForm.key.label", { defaultValue: "Key" })}
          </Label>
          <Input
            ref={keyRef}
            {...keyAgentProps}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="OPENROUTER_API_KEY"
            className="h-8 font-mono text-xs"
            autoComplete="off"
            required
          />
        </div>
        <div>
          <Label className="text-2xs text-muted">
            {t("vaultinventory.addForm.displayLabel.label", {
              defaultValue: "Display label",
            })}
          </Label>
          <Input
            ref={labelRef}
            {...labelAgentProps}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="OpenRouter"
            className="h-8 text-xs"
            autoComplete="off"
          />
        </div>
      </div>
      <div>
        <Label className="text-2xs text-muted">
          {t("vaultinventory.addForm.value.label", { defaultValue: "Value" })}
        </Label>
        <Input
          ref={valueRef}
          {...valueAgentProps}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 font-mono text-xs"
          autoComplete="new-password"
          required
        />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <Label className="text-2xs text-muted">
            {t("vaultinventory.addForm.category.label", {
              defaultValue: "Category",
            })}
          </Label>
          <Select
            value={category}
            onValueChange={(value) => setCategory(value as VaultEntryCategory)}
          >
            <SettingsSelectTrigger
              ref={categoryRef}
              variant="soft"
              className="block w-full"
              aria-label="Secret category"
              {...categoryAgentProps}
            >
              <SelectValue />
            </SettingsSelectTrigger>
            <SelectContent>
              {CATEGORY_INPUT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(opt.labelKey, { defaultValue: opt.defaultLabel })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-2xs text-muted">
            {t("vaultinventory.addForm.providerId.label", {
              defaultValue: "Provider id (optional)",
            })}
          </Label>
          <Input
            ref={providerRef}
            {...providerAgentProps}
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            placeholder="openrouter"
            className="h-8 text-xs"
            autoComplete="off"
          />
        </div>
      </div>

      {err && (
        <p className="text-2xs text-danger" aria-live="polite">
          {err}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button
          ref={cancelRef}
          {...cancelAgentProps}
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-sm px-3 text-xs"
          onClick={onClose}
          disabled={submitting}
        >
          {t("vaultinventory.addForm.cancel", { defaultValue: "Cancel" })}
        </Button>
        <Button
          ref={saveRef}
          {...saveAgentProps}
          type="submit"
          variant="default"
          size="sm"
          className="h-7 rounded-sm px-3 text-xs"
          disabled={submitting || !key.trim() || !value}
        >
          {submitting
            ? t("vaultinventory.addForm.saving", { defaultValue: "Saving…" })
            : t("vaultinventory.addForm.save", {
                defaultValue: "Save secret",
              })}
        </Button>
      </div>
    </form>
  );
}
