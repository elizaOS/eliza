import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@elizaos/ui";
import { KeyRound, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dispatchSecretsManagerOpen,
  useSecretsManagerModalState,
  VAULT_TABS,
  type VaultTab,
} from "../../hooks/useSecretsManagerModal";
import { getShortcutLabel } from "../../hooks/useSecretsManagerShortcut";
import { LoginsTab } from "./vault-tabs/LoginsTab";
import { OverviewTab } from "./vault-tabs/OverviewTab";
import { RoutingTab } from "./vault-tabs/RoutingTab";
import { SecretsTab } from "./vault-tabs/SecretsTab";
import type {
  AgentSummary,
  BackendStatus,
  InstallableBackendId,
  InstalledApp,
  InstallMethod,
  ManagerPreferences,
  RoutingConfig,
  VaultEntryMeta,
  VaultTabNavigate,
} from "./vault-tabs/types";

/**
 * Settings → Vault section.
 *
 * Two exports:
 *  - `SecretsManagerSection` — the inline launcher row in Settings.
 *    Shows current primary backend + status; clicking dispatches the
 *    global open event for the modal. Doesn't mount the modal itself.
 *  - `SecretsManagerModalRoot` — the modal's top-level mount. Should
 *    be rendered ONCE at app root (alongside SaveCommandModal etc.
 *    in App.tsx). Subscribes to global open/close state so any
 *    trigger (Settings launcher, ⌘⌥⌃V keyboard chord, application
 *    menu accelerator) shows it.
 *
 * The modal itself is a tabbed Vault interface: Overview / Secrets /
 * Logins / Routing. Each tab is a separate file under `vault-tabs/`.
 * Data is fetched once per modal-open and shared across tabs via
 * props; mutations call back to the modal to refresh.
 */

const HASH_PREFIX = "vault";

function readHashTab(): VaultTab | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith(`${HASH_PREFIX}/`)) return null;
  const candidate = hash.slice(HASH_PREFIX.length + 1) as VaultTab;
  return VAULT_TABS.includes(candidate) ? candidate : null;
}

function writeHashTab(tab: VaultTab): void {
  if (typeof window === "undefined") return;
  const next = `#${HASH_PREFIX}/${tab}`;
  if (window.location.hash === next) return;
  // Replace, not push, so closing the modal doesn't litter the back stack
  // with intermediate tab states.
  history.replaceState(null, "", next);
}

function clearHash(): void {
  if (typeof window === "undefined") return;
  if (!window.location.hash.startsWith(`#${HASH_PREFIX}`)) return;
  history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
}

// ── Public components ──────────────────────────────────────────────

export function SecretsManagerSection() {
  const [primary, setPrimary] = useState<BackendStatus | null>(null);
  const [enabledCount, setEnabledCount] = useState<number>(1);
  const { isOpen } = useSecretsManagerModalState();

  const refreshSummary = useCallback(async () => {
    const [bRes, pRes] = await Promise.all([
      fetch("/api/secrets/manager/backends"),
      fetch("/api/secrets/manager/preferences"),
    ]);
    if (!bRes.ok || !pRes.ok) return;
    const bJson = (await bRes.json()) as { backends: BackendStatus[] };
    const pJson = (await pRes.json()) as { preferences: ManagerPreferences };
    const primaryId = pJson.preferences.enabled[0] ?? "in-house";
    setPrimary(bJson.backends.find((b) => b.id === primaryId) ?? null);
    setEnabledCount(pJson.preferences.enabled.length);
  }, []);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  useEffect(() => {
    if (!isOpen) void refreshSummary();
  }, [isOpen, refreshSummary]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-bg/50 text-muted">
            <KeyRound className="h-3.5 w-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-sm text-txt">
                {primary?.label ?? "Local (encrypted)"}
              </span>
              {primary && (
                <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent">
                  Primary
                </span>
              )}
              {enabledCount > 1 && (
                <span className="rounded-full border border-border/50 bg-bg/40 px-1.5 py-0.5 text-2xs text-muted">
                  +{enabledCount - 1} more
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-2xs text-muted">
              Where sensitive values like API keys are stored.
              <span className="ml-1 text-muted/70">({getShortcutLabel()})</span>
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0 rounded-lg"
          onClick={() => dispatchSecretsManagerOpen()}
        >
          Manage…
        </Button>
      </div>
    </section>
  );
}

export function SecretsManagerModalRoot() {
  // The modal-state hook is the single source of truth. We forward
  // its initial-tab / focus payload directly to `VaultModal` as props
  // rather than re-subscribing to the event from the modal body — that
  // would double the listeners and risk dropping the dispatch payload
  // for the body's hook (which mounts after the dispatch fires).
  const { isOpen, initialTab, focusKey, focusProfileId, setOpen, clearFocus } =
    useSecretsManagerModalState();
  return (
    <VaultModal
      open={isOpen}
      onOpenChange={setOpen}
      initialTab={initialTab}
      initialFocusKey={focusKey}
      initialFocusProfileId={focusProfileId}
      onConsumeInitial={clearFocus}
    />
  );
}

// ── Vault modal shell ──────────────────────────────────────────────

export interface VaultModalProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /**
   * Optional tab to land on when opening. Owner is responsible for
   * resetting via `onConsumeInitial` after the modal opens so the
   * next open uses the user's most recent tab again.
   */
  initialTab?: VaultTab | null;
  initialFocusKey?: string | null;
  initialFocusProfileId?: string | null;
  onConsumeInitial?: () => void;
}

export function VaultModal({
  open,
  onOpenChange,
  initialTab = null,
  initialFocusKey = null,
  initialFocusProfileId = null,
  onConsumeInitial,
}: VaultModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden sm:max-w-4xl">
        <VaultBody
          open={open}
          onOpenChange={onOpenChange}
          initialTab={initialTab}
          initialFocusKey={initialFocusKey}
          initialFocusProfileId={initialFocusProfileId}
          onConsumeInitial={onConsumeInitial}
        />
      </DialogContent>
    </Dialog>
  );
}

function VaultBody({
  open,
  onOpenChange,
  initialTab,
  initialFocusKey,
  initialFocusProfileId,
  onConsumeInitial,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  initialTab: VaultTab | null;
  initialFocusKey: string | null;
  initialFocusProfileId: string | null;
  onConsumeInitial?: () => void;
}) {
  // Stash the hash that was present when the modal opened so closing
  // the modal restores it. Without this we'd nuke `#secrets` (settings
  // section anchor) every time the user popped the modal open and
  // closed it, breaking the SettingsView deep-link contract.
  const priorHashRef = useRef<string>("");

  // Tab state. Resolved in this order: (1) initial dispatch detail,
  // (2) hash, (3) "overview". Subsequent tab changes update the hash so
  // the URL is shareable / restorable.
  const [activeTab, setActiveTab] = useState<VaultTab>(
    () => initialTab ?? readHashTab() ?? "overview",
  );

  // Cross-tab focus (key + optional profile id). The receiving tab
  // applies this and calls `clearFocusState()` to prevent re-application
  // on every parent re-render.
  const [focusKey, setFocusKey] = useState<string | null>(initialFocusKey);
  const [focusProfileId, setFocusProfileId] = useState<string | null>(
    initialFocusProfileId,
  );
  const clearFocusState = useCallback(() => {
    setFocusKey(null);
    setFocusProfileId(null);
  }, []);

  // When the parent forwards a new initial tab / focus (modal re-opened
  // via dispatch with new payload), sync local state and signal the
  // owner to clear so we don't re-apply on every re-render.
  useEffect(() => {
    if (!open) return;
    if (initialTab) setActiveTab(initialTab);
    if (initialFocusKey !== null) setFocusKey(initialFocusKey);
    if (initialFocusProfileId !== null)
      setFocusProfileId(initialFocusProfileId);
    if (initialTab || initialFocusKey || initialFocusProfileId) {
      onConsumeInitial?.();
    }
  }, [
    open,
    initialTab,
    initialFocusKey,
    initialFocusProfileId,
    onConsumeInitial,
  ]);

  // Capture the prior hash on open so close can restore it.
  useEffect(() => {
    if (!open) return;
    if (typeof window === "undefined") return;
    const current = window.location.hash;
    // Don't overwrite if the open was triggered BY a `#vault/<tab>` paste —
    // that hash is ours, not the prior settings hash.
    if (!current.startsWith(`#${HASH_PREFIX}`)) {
      priorHashRef.current = current;
    }
  }, [open]);

  // Sync hash on tab change while open.
  useEffect(() => {
    if (!open) return;
    writeHashTab(activeTab);
  }, [open, activeTab]);

  // On close, restore prior hash (or strip the vault hash if none).
  useEffect(() => {
    if (open) return;
    if (typeof window === "undefined") return;
    if (!window.location.hash.startsWith(`#${HASH_PREFIX}`)) return;
    if (priorHashRef.current) {
      history.replaceState(null, "", priorHashRef.current);
    } else {
      clearHash();
    }
  }, [open]);

  // Listen for external hash changes (e.g. user pasted a URL).
  useEffect(() => {
    if (!open) return;
    const onHashChange = () => {
      const next = readHashTab();
      if (next && next !== activeTab) setActiveTab(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [open, activeTab]);

  // ── Data ───────────────────────────────────────────────────────
  const [backends, setBackends] = useState<BackendStatus[] | null>(null);
  const [preferences, setPreferences] = useState<ManagerPreferences | null>(
    null,
  );
  const [installMethods, setInstallMethods] = useState<Record<
    InstallableBackendId,
    InstallMethod[]
  > | null>(null);
  const [entries, setEntries] = useState<VaultEntryMeta[] | null>(null);
  const [routingConfig, setRoutingConfig] = useState<RoutingConfig | null>(
    null,
  );
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        backendsRes,
        prefsRes,
        methodsRes,
        entriesRes,
        routingRes,
        agentsRes,
        appsRes,
      ] = await Promise.all([
        fetch("/api/secrets/manager/backends"),
        fetch("/api/secrets/manager/preferences"),
        fetch("/api/secrets/manager/install/methods"),
        fetch("/api/secrets/inventory"),
        fetch("/api/secrets/routing"),
        fetch("/api/agents").catch(() => null),
        fetch("/api/apps").catch(() => null),
      ]);
      if (!backendsRes.ok)
        throw new Error(`backends: HTTP ${backendsRes.status}`);
      if (!prefsRes.ok) throw new Error(`preferences: HTTP ${prefsRes.status}`);
      if (!methodsRes.ok)
        throw new Error(`install/methods: HTTP ${methodsRes.status}`);
      if (!entriesRes.ok)
        throw new Error(`inventory: HTTP ${entriesRes.status}`);
      if (!routingRes.ok) throw new Error(`routing: HTTP ${routingRes.status}`);
      const backendsJson = (await backendsRes.json()) as {
        backends: BackendStatus[];
      };
      const prefsJson = (await prefsRes.json()) as {
        preferences: ManagerPreferences;
      };
      const methodsJson = (await methodsRes.json()) as {
        methods: Record<InstallableBackendId, InstallMethod[]>;
      };
      const entriesJson = (await entriesRes.json()) as {
        entries: VaultEntryMeta[];
      };
      const routingJson = (await routingRes.json()) as {
        config: RoutingConfig;
      };
      setBackends(backendsJson.backends);
      setPreferences(prefsJson.preferences);
      setInstallMethods(methodsJson.methods);
      setEntries(entriesJson.entries);
      setRoutingConfig(routingJson.config);
      // Best-effort agent/app fetches — endpoints may not exist in headless
      // / test environments. The Routing tab still works without them.
      if (agentsRes?.ok) {
        const aJson = (await agentsRes.json()) as { agents?: AgentSummary[] };
        setAgents(aJson.agents ?? []);
      } else {
        setAgents([]);
      }
      if (appsRes?.ok) {
        const aJson = (await appsRes.json()) as { apps?: InstalledApp[] };
        setApps(aJson.apps ?? []);
      } else {
        setApps([]);
      }
    } catch (err) {
      // Boundary translation: a failed bulk load surfaces in a single
      // banner; tabs that don't depend on the failed endpoint still
      // render usable empty states from their own state.
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Refresh inventory + routing after any tab mutation. Cheaper than a
  // full re-load but always gives sibling tabs the latest data.
  const refreshInventory = useCallback(async () => {
    const [entriesRes, routingRes] = await Promise.all([
      fetch("/api/secrets/inventory"),
      fetch("/api/secrets/routing"),
    ]);
    if (entriesRes.ok) {
      const json = (await entriesRes.json()) as { entries: VaultEntryMeta[] };
      setEntries(json.entries);
    }
    if (routingRes.ok) {
      const json = (await routingRes.json()) as { config: RoutingConfig };
      setRoutingConfig(json.config);
    }
  }, []);

  // Clear the "Saved" label after 2.5s.
  useEffect(() => {
    if (savedAt === null) return;
    const id = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(id);
  }, [savedAt]);

  const save = useCallback(async () => {
    if (!preferences) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/secrets/manager/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferences }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { preferences: ManagerPreferences };
      setPreferences(json.preferences);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }, [preferences]);

  const onSignout = useCallback(
    async (backendId: InstallableBackendId) => {
      const res = await fetch("/api/secrets/manager/signout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backendId }),
      });
      if (!res.ok) {
        setError(`sign-out HTTP ${res.status}`);
        return;
      }
      await load();
    },
    [load],
  );

  // Cross-tab navigation handed to each tab via props.
  const navigate = useMemo<VaultTabNavigate>(
    () => (target) => {
      setActiveTab(target.tab);
      setFocusKey(target.focusKey ?? null);
      setFocusProfileId(target.focusProfileId ?? null);
    },
    [],
  );

  const onTabChange = useCallback((next: string) => {
    if (VAULT_TABS.includes(next as VaultTab)) {
      setActiveTab(next as VaultTab);
    }
  }, []);

  const isReady = !loading && backends && preferences && installMethods;

  return (
    <>
      <DialogHeader className="shrink-0">
        <DialogTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted" aria-hidden />
            Vault
          </span>
          <span className="rounded-md border border-border/50 bg-bg/40 px-2 py-0.5 font-mono text-2xs font-normal text-muted">
            {getShortcutLabel()}
          </span>
        </DialogTitle>
        <DialogDescription>
          One stop for backends, secrets, saved logins, and per-context routing.
          Local storage is always available as the fallback.
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-2">
        {!isReady || !backends || !preferences || !installMethods ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
          </div>
        ) : (
          <>
            {error && (
              <div
                aria-live="polite"
                data-testid="vault-modal-error"
                className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
              >
                {error}
              </div>
            )}

            <Tabs
              value={activeTab}
              onValueChange={onTabChange}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="h-9 shrink-0 self-start">
                <TabsTrigger value="overview" data-testid="vault-tab-overview">
                  Overview
                </TabsTrigger>
                <TabsTrigger value="secrets" data-testid="vault-tab-secrets">
                  Secrets
                </TabsTrigger>
                <TabsTrigger value="logins" data-testid="vault-tab-logins">
                  Logins
                </TabsTrigger>
                <TabsTrigger value="routing" data-testid="vault-tab-routing">
                  Routing
                </TabsTrigger>
              </TabsList>

              <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
                <TabsContent
                  value="overview"
                  className="mt-0"
                  data-testid="vault-tab-overview-content"
                >
                  <OverviewTab
                    backends={backends}
                    preferences={preferences}
                    installMethods={installMethods}
                    saving={saving}
                    savedAt={savedAt}
                    onPreferencesChange={setPreferences}
                    onSave={() => void save()}
                    onReload={() => void load()}
                    onInstallComplete={() => void load()}
                    onSigninComplete={() => void load()}
                    onSignout={(id) => void onSignout(id)}
                  />
                </TabsContent>

                <TabsContent
                  value="secrets"
                  className="mt-0"
                  data-testid="vault-tab-secrets-content"
                >
                  <SecretsTab
                    entries={entries ?? []}
                    onChanged={() => void refreshInventory()}
                    navigate={navigate}
                    focusKey={activeTab === "secrets" ? focusKey : null}
                    focusProfileId={
                      activeTab === "secrets" ? focusProfileId : null
                    }
                    onFocusApplied={clearFocusState}
                  />
                </TabsContent>

                <TabsContent
                  value="logins"
                  className="mt-0"
                  data-testid="vault-tab-logins-content"
                >
                  <LoginsTab />
                </TabsContent>

                <TabsContent
                  value="routing"
                  className="mt-0"
                  data-testid="vault-tab-routing-content"
                >
                  <RoutingTab
                    config={routingConfig ?? { rules: [] }}
                    agents={agents}
                    apps={apps}
                    entries={entries ?? []}
                    onConfigChange={setRoutingConfig}
                    navigate={navigate}
                    focusKey={activeTab === "routing" ? focusKey : null}
                    onFocusApplied={clearFocusState}
                  />
                </TabsContent>
              </div>
            </Tabs>
          </>
        )}
      </div>

      <DialogFooter className="flex shrink-0 flex-row items-center justify-between gap-3 border-t border-border/30 pt-3 sm:justify-between">
        <p className="text-2xs text-muted sm:max-w-sm">
          Non-sensitive config always stays in-house.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-9 rounded-lg"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Close
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

// ── Re-exports for legacy imports ──────────────────────────────────
//
// External callers (tests, App root mounts) historically imported
// `BackendRow`, `SavedLoginsPanel`, and `SecretsManagerModal` from this
// file. Re-export them so the move into `vault-tabs/` doesn't break
// anything that hasn't migrated yet.

export { LoginsTab as SavedLoginsPanel } from "./vault-tabs/LoginsTab";
export {
  BackendRow,
  InstallSheet,
  SigninSheet,
} from "./vault-tabs/OverviewTab";
export { VaultModal as SecretsManagerModal };
