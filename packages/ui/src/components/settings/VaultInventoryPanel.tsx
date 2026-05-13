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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
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
  label: string;
}> = [
  { value: "provider", label: "Provider" },
  { value: "plugin", label: "Plugin" },
  { value: "wallet", label: "Wallet" },
  { value: "credential", label: "Saved login" },
  { value: "session", label: "Session" },
  { value: "system", label: "System" },
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
      const res = await fetch("/api/secrets/inventory");
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
    for (const e of entries ?? []) buckets[e.category].push(e);
    return buckets;
  }, [entries]);

  return (
    <section data-testid="vault-inventory-panel" className="space-y-2 pt-1">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-txt">Stored secrets</p>
          <p className="text-2xs text-muted">
            Every secret stored locally, grouped by category. Add API keys,
            wallet keys, and plugin tokens here.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1 rounded-md px-2"
          onClick={() => setShowAdd((v) => !v)}
          aria-label="Add secret"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add secret
        </Button>
      </div>

      {error && (
        <div
          aria-live="polite"
          data-testid="vault-inventory-error"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger"
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
        <div
          data-testid="vault-inventory-empty"
          className="rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted"
        >
          No secrets stored yet. Add an API key to get started.
        </div>
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

function CategoryGroup({
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
      <p className="text-2xs font-semibold uppercase tracking-wide text-muted">
        {CATEGORY_LABEL[category]}
      </p>
      <ul className="space-y-1 rounded-md border border-border/40 bg-card/30 p-1">
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
}

// ── Single entry row ───────────────────────────────────────────────

function EntryRow({
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
  const [revealed, setRevealed] = useState<{
    value: string;
    source: string;
    profileId?: string;
  } | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

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
    const res = await fetch(
      `/api/secrets/inventory/${encodeURIComponent(entry.key)}`,
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
    const res = await fetch(
      `/api/secrets/inventory/${encodeURIComponent(entry.key)}`,
      { method: "DELETE" },
    );
    if (res.ok) onChanged();
  }, [entry.key, entry.label, onChanged]);

  const profileCount = entry.profiles?.length ?? 0;

  return (
    <div
      ref={rowRef}
      data-testid={`vault-entry-row-${entry.key}`}
      className="rounded px-2 py-1.5 hover:bg-bg-muted/30"
    >
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 rounded-md p-0 text-muted"
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
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 rounded-md px-2 text-xs text-muted"
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
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 rounded-md px-2 text-xs text-muted"
            onClick={hide}
            aria-label={`Hide ${entry.label}`}
          >
            <EyeOff className="h-3.5 w-3.5" aria-hidden />
            Hide
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 rounded-md p-0 text-muted hover:text-danger"
          onClick={() => void onDelete()}
          aria-label={`Delete ${entry.label}`}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      {revealed && (
        <div
          data-testid={`vault-revealed-${entry.key}`}
          className="mt-1.5 flex items-center gap-2 rounded-md border border-border/50 bg-bg/40 p-2"
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
            className="h-6 shrink-0 gap-1 rounded-md px-2 text-2xs"
            onClick={() => void copy()}
            aria-label="Copy"
          >
            <Copy className="h-3 w-3" aria-hidden /> Copy
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
}

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
  const [showAdd, setShowAdd] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);

  const profiles = entry.profiles ?? [];
  const hasProfiles = profiles.length > 0;

  const onAdd = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!newId || !newValue) return;
      setSubmitting(true);
      setErr(null);
      const res = await fetch(
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
      const res = await fetch(
        `/api/secrets/inventory/${encodeURIComponent(entry.key)}/active-profile`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profileId }),
        },
      );
      if (res.ok) onChanged();
    },
    [entry.key, onChanged],
  );

  const onDelete = useCallback(
    async (profileId: string) => {
      const confirmed = window.confirm(`Delete profile "${profileId}"?`);
      if (!confirmed) return;
      const res = await fetch(
        `/api/secrets/inventory/${encodeURIComponent(entry.key)}/profiles/${encodeURIComponent(profileId)}`,
        { method: "DELETE" },
      );
      if (res.ok) onChanged();
    },
    [entry.key, onChanged],
  );

  const onMigrate = useCallback(async () => {
    setMigrating(true);
    setErr(null);
    const res = await fetch("/api/secrets/inventory/migrate-to-profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: entry.key }),
    });
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
      className="mt-2 space-y-2 rounded-md border border-border/40 bg-bg/30 p-2"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs font-semibold uppercase text-muted">Profiles</p>
        <div className="flex items-center gap-1">
          {hasProfiles && onJumpToRouting && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 rounded-md px-2 text-2xs"
              onClick={() => onJumpToRouting(entry.key)}
              aria-label={`Routing rules for ${entry.label}`}
            >
              Routing rules for this profile
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Button>
          )}
          {hasProfiles ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 rounded-md px-2 text-2xs"
              onClick={() => setShowAdd((v) => !v)}
              aria-label="Add profile"
            >
              <Plus className="h-3 w-3" aria-hidden /> Add profile
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 rounded-md px-2 text-2xs"
              onClick={() => void onMigrate()}
              disabled={migrating}
              aria-label="Enable profiles for this key"
            >
              {migrating ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-3 w-3" aria-hidden />
              )}
              Enable profiles
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
          {profiles.map((p) => {
            const highlight = highlightProfileId === p.id;
            return (
              <li
                key={p.id}
                className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${highlight ? "ring-1 ring-accent/40" : ""}`}
              >
                <input
                  type="radio"
                  name={`active-${entry.key}`}
                  checked={entry.activeProfile === p.id}
                  onChange={() => void onActivate(p.id)}
                  className="h-3 w-3 cursor-pointer accent-accent"
                  aria-label={`Make ${p.label} active`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-txt">{p.label}</p>
                  <p className="truncate font-mono text-2xs text-muted">
                    {p.id}
                  </p>
                </div>
                {entry.activeProfile === p.id && (
                  <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent">
                    <CheckCircle2 className="h-3 w-3" aria-hidden /> Active
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 shrink-0 rounded-md p-0 text-muted hover:text-danger"
                  aria-label={`Delete profile ${p.label}`}
                  onClick={() => void onDelete(p.id)}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {showAdd && (
        <form
          onSubmit={onAdd}
          data-testid={`add-profile-form-${entry.key}`}
          className="space-y-1.5 rounded-md border border-border/40 bg-card/40 p-2"
        >
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            <div>
              <Label className="text-2xs text-muted">Profile id</Label>
              <Input
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="work"
                className="h-7 text-xs"
                pattern="[A-Za-z0-9_-]+"
                required
              />
            </div>
            <div>
              <Label className="text-2xs text-muted">Display label</Label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Work"
                className="h-7 text-xs"
              />
            </div>
          </div>
          <div>
            <Label className="text-2xs text-muted">Value</Label>
            <Input
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
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 rounded-md px-2 text-2xs"
              onClick={() => setShowAdd(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              className="h-6 rounded-md px-2 text-2xs"
              disabled={submitting || !newId || !newValue}
            >
              {submitting ? "Saving…" : "Save profile"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Add-secret form ────────────────────────────────────────────────

function AddSecretForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [providerId, setProviderId] = useState("");
  const [category, setCategory] = useState<VaultEntryCategory>("plugin");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!key.trim() || !value) return;
      setSubmitting(true);
      setErr(null);
      const res = await fetch(
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
      className="space-y-2 rounded-md border border-border/50 bg-card/30 p-2"
    >
      <p className="text-2xs text-muted">
        Stored locally and encrypted at rest. The key is the env-var-style
        identifier; the value is what plugins read at runtime.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <Label className="text-2xs text-muted">Key</Label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="OPENROUTER_API_KEY"
            className="h-8 font-mono text-xs"
            autoComplete="off"
            required
          />
        </div>
        <div>
          <Label className="text-2xs text-muted">Display label</Label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="OpenRouter"
            className="h-8 text-xs"
            autoComplete="off"
          />
        </div>
      </div>
      <div>
        <Label className="text-2xs text-muted">Value</Label>
        <Input
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
          <Label className="text-2xs text-muted">Category</Label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as VaultEntryCategory)}
            className="block h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-txt"
          >
            {CATEGORY_INPUT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-2xs text-muted">Provider id (optional)</Label>
          <Input
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
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-md px-3 text-xs"
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="default"
          size="sm"
          className="h-7 rounded-md px-3 text-xs"
          disabled={submitting || !key.trim() || !value}
        >
          {submitting ? "Saving…" : "Save secret"}
        </Button>
      </div>
    </form>
  );
}
