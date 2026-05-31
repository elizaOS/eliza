import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import type { SecretInfo } from "../../api";
import { client } from "../../api";
import { ContentLayout } from "../../layouts/content-layout/content-layout";
import { useApp } from "../../state";
import type { TranslateFn } from "../../types";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

/* ── Constants ──────────────────────────────────────────────────────── */

const STORAGE_KEY = "eliza:secrets-vault-keys";

const CATEGORY_ORDER = [
  "ai-provider",
  "blockchain",
  "connector",
  "auth",
  "other",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  "ai-provider": "AI Providers",
  blockchain: "Blockchain",
  connector: "Connectors",
  auth: "Authentication",
  other: "Other",
};

type GroupedSecrets = {
  category: string;
  label: string;
  secrets: SecretInfo[];
};

const fallbackTranslate: TranslateFn = (key, vars) =>
  typeof vars?.defaultValue === "string" ? vars.defaultValue : key;

function slugifyKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function groupSecretsByCategory(secrets: SecretInfo[]): GroupedSecrets[] {
  const grouped = new Map<string, SecretInfo[]>();
  for (const secret of secrets) {
    const existing = grouped.get(secret.category);
    if (existing) {
      existing.push(secret);
    } else {
      grouped.set(secret.category, [secret]);
    }
  }

  return CATEGORY_ORDER.filter((category) => grouped.has(category)).map(
    (category) => ({
      category,
      label: CATEGORY_LABELS[category],
      secrets: grouped.get(category) ?? [],
    }),
  );
}

/* ── Persistence ────────────────────────────────────────────────────── */

function loadPinnedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // localStorage unavailable: return empty set
  }
  return new Set();
}

function savePinnedKeys(keys: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // localStorage unavailable: pin state is not persisted
  }
}

/* ── Component ──────────────────────────────────────────────────────── */

export function SecretsView({
  contentHeader,
  inModal,
}: {
  contentHeader?: React.ReactNode;
  inModal?: boolean;
} = {}) {
  const app = useApp() as ReturnType<typeof useApp> | undefined;
  const t = app?.t ?? fallbackTranslate;
  const [allSecrets, setAllSecrets] = useState<SecretInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(loadPinnedKeys);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.getSecrets();
      setAllSecrets(res.secrets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load secrets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Vault secrets = pinned by user OR already set in env
  const vaultSecrets = useMemo(() => {
    return allSecrets.filter((s) => pinnedKeys.has(s.key) || s.isSet);
  }, [allSecrets, pinnedKeys]);

  // Available secrets not in the vault (for the picker)
  const availableSecrets = useMemo(() => {
    const vaultKeys = new Set(vaultSecrets.map((s) => s.key));
    const available = allSecrets.filter((s) => !vaultKeys.has(s.key));
    if (!pickerSearch.trim()) return available;
    const q = pickerSearch.toLowerCase();
    return available.filter(
      (s) =>
        s.key.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.usedBy.some((u) => u.pluginName.toLowerCase().includes(q)),
    );
  }, [allSecrets, vaultSecrets, pickerSearch]);

  // Group vault secrets by category
  const grouped = useMemo(() => {
    return groupSecretsByCategory(vaultSecrets);
  }, [vaultSecrets]);

  const dirtyKeys = useMemo(() => {
    return Object.keys(draft).filter((k) => draft[k].trim() !== "");
  }, [draft]);

  const pinKey = (key: string) => {
    setPinnedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      savePinnedKeys(next);
      return next;
    });
  };

  const unpinKey = (key: string) => {
    setPinnedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      savePinnedKeys(next);
      return next;
    });
    setDraft((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleSave = async () => {
    if (dirtyKeys.length === 0) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const payload: Record<string, string> = {};
      for (const key of dirtyKeys) payload[key] = draft[key];
      const res = await client.updateSecrets(payload);
      setSaveResult({
        ok: true,
        message: `Updated ${res.updated.length} secret${res.updated.length !== 1 ? "s" : ""}`,
      });
      setDraft({});
      await load();
    } catch (err) {
      setSaveResult({
        ok: false,
        message: err instanceof Error ? err.message : "Save failed",
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleCollapse = (cat: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const toggleVisible = (key: string) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const retryAgent = useAgentElement<HTMLButtonElement>({
    id: "retry",
    role: "button",
    label: t("common.retry"),
    group: "secrets-actions",
    description: "Retry loading the secrets vault",
    onActivate: load,
  });
  const addSecretAgent = useAgentElement<HTMLButtonElement>({
    id: "add-secret",
    role: "button",
    label: t("secretsview.AddSecret"),
    group: "secrets-actions",
    description: "Open the picker to add a secret to the vault",
    onActivate: () => {
      setPickerOpen(true);
      setPickerSearch("");
    },
  });
  const saveAgent = useAgentElement<HTMLButtonElement>({
    id: "save-secrets",
    role: "button",
    label: t("common.save"),
    group: "secrets-actions",
    status: dirtyKeys.length === 0 || saving ? "inactive" : "active",
    description: "Save pending secret changes",
    onActivate: handleSave,
  });

  if (loading) {
    return (
      <ShellViewAgentSurface viewId="secrets">
        <ContentLayout contentHeader={contentHeader} inModal={inModal}>
          <div className="rounded-sm border border-border/50 bg-card/92 py-8 text-center text-sm italic text-muted">
            {t("secretsview.LoadingSecrets")}
          </div>
        </ContentLayout>
      </ShellViewAgentSurface>
    );
  }

  if (error) {
    return (
      <ShellViewAgentSurface viewId="secrets">
        <ContentLayout contentHeader={contentHeader} inModal={inModal}>
          <div className="rounded-sm border border-border/50 bg-card/92 px-4 py-8 text-center">
            <div className="mb-2 text-sm text-danger">{error}</div>
            <Button
              ref={retryAgent.ref}
              variant="outline"
              size="sm"
              className="h-8 px-3 text-sm"
              onClick={load}
              {...retryAgent.agentProps}
            >
              {t("common.retry")}
            </Button>
          </div>
        </ContentLayout>
      </ShellViewAgentSurface>
    );
  }

  return (
    <ShellViewAgentSurface viewId="secrets">
      <ContentLayout contentHeader={contentHeader} inModal={inModal}>
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="m-0 max-w-2xl text-sm leading-6 text-muted" />
          <Button
            ref={addSecretAgent.ref}
            variant="default"
            size="sm"
            className="h-9 flex-shrink-0 px-3 text-sm "
            onClick={() => {
              setPickerOpen(true);
              setPickerSearch("");
            }}
            {...addSecretAgent.agentProps}
          >
            {t("secretsview.AddSecret")}
          </Button>
        </div>

        {/* Picker modal */}
        {pickerOpen && (
          <SecretPicker
            available={availableSecrets}
            search={pickerSearch}
            onSearchChange={setPickerSearch}
            onAdd={(key) => {
              pinKey(key);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}

        {/* Empty state */}
        {vaultSecrets.length === 0 && (
          <div className="rounded-sm border border-border/50 bg-card/92 border-dashed px-4 py-8 text-center text-sm italic text-muted">
            {t("secretsview.YourVaultIsEmpty")}
          </div>
        )}

        {/* Vault secrets grouped by category */}
        {grouped.map(({ category, label, secrets: catSecrets }) => (
          <section key={category} className="space-y-3">
            <CategoryToggleButton
              category={category}
              label={label}
              count={catSecrets.length}
              collapsed={collapsed.has(category)}
              onToggle={() => toggleCollapse(category)}
            />

            {!collapsed.has(category) && (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {catSecrets.map((secret) => (
                  <SecretCard
                    key={secret.key}
                    secret={secret}
                    draftValue={draft[secret.key] ?? ""}
                    isVisible={visible.has(secret.key)}
                    isPinned={pinnedKeys.has(secret.key)}
                    onToggleVisible={() => toggleVisible(secret.key)}
                    onDraftChange={(val) =>
                      setDraft((prev) => ({ ...prev, [secret.key]: val }))
                    }
                    onRemove={() => unpinKey(secret.key)}
                  />
                ))}
              </div>
            )}
          </section>
        ))}

        {/* Save bar */}
        {vaultSecrets.length > 0 && (
          <div className="rounded-sm border border-border/50 bg-card/92 flex flex-col gap-3 border-border/60 px-4 py-3 sm:flex-row sm:items-center">
            <Button
              ref={saveAgent.ref}
              variant="default"
              size="sm"
              className="h-9 px-4 text-sm font-medium transition-colors"
              disabled={dirtyKeys.length === 0 || saving}
              onClick={handleSave}
              {...saveAgent.agentProps}
            >
              {saving
                ? t("common.saving", {
                    defaultValue: "Saving...",
                  })
                : dirtyKeys.length > 0
                  ? `${t("common.save")} (${dirtyKeys.length})`
                  : t("common.save")}
            </Button>
            {saveResult && (
              <span
                className={`text-sm ${saveResult.ok ? "text-ok" : "text-danger"}`}
              >
                {saveResult.message}
              </span>
            )}
          </div>
        )}
      </div>
      </ContentLayout>
    </ShellViewAgentSurface>
  );
}

/* ── Category Toggle ────────────────────────────────────────────────── */

function CategoryToggleButton({
  category,
  label,
  count,
  collapsed,
  onToggle,
}: {
  category: string;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `category-${slugifyKey(category)}`,
    role: "button",
    label,
    group: "secrets-categories",
    status: collapsed ? "inactive" : "active",
    description: `Toggle the ${label} secrets category`,
    onActivate: onToggle,
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      className="mb-3 h-auto w-full items-center gap-2 rounded-sm border border-transparent px-3 py-2 text-left hover:border-border/50 hover:bg-bg-hover"
      onClick={onToggle}
      aria-expanded={!collapsed}
      {...agentProps}
    >
      <ChevronDown
        className="h-3 w-3 select-none text-muted transition-transform"
        style={{
          transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
        }}
      />
      <span className="text-sm font-semibold text-txt">{label}</span>
      <span className="text-xs text-muted">({count})</span>
    </Button>
  );
}

/* ── Secret Picker ──────────────────────────────────────────────────── */

function SecretPicker({
  available,
  search,
  onSearchChange,
  onAdd,
  onClose,
}: {
  available: SecretInfo[];
  search: string;
  onSearchChange: (v: string) => void;
  onAdd: (key: string) => void;
  onClose: () => void;
}) {
  const app = useApp() as ReturnType<typeof useApp> | undefined;
  const t = app?.t ?? fallbackTranslate;
  // Group available by category
  const grouped = useMemo(() => {
    return groupSecretsByCategory(available);
  }, [available]);

  const searchAgent = useAgentElement<HTMLInputElement>({
    id: "picker-search",
    role: "text-input",
    label: t("secretsview.SearchByKeyDescr"),
    group: "secrets-picker",
    description: "Search available secrets to add to the vault",
    getValue: () => search,
    onFill: onSearchChange,
  });
  const closePickerAgent = useAgentElement<HTMLButtonElement>({
    id: "picker-close",
    role: "button",
    label: t("common.close"),
    group: "secrets-picker",
    description: "Close the add-secret picker",
    onActivate: onClose,
  });

  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-[min(calc(100%_-_2rem),35rem)] max-h-[min(80vh,36rem)] overflow-hidden rounded-sm border border-border/60 bg-card/96 p-0 "
      >
        <DialogHeader className="flex flex-row items-center justify-between px-4 py-3">
          <div className="min-w-0">
            <DialogTitle className="text-sm font-semibold text-txt">
              {t("secretsview.AddSecretsToVault")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("secretsview.SearchByKeyDescr")}
            </DialogDescription>
          </div>
          <Button
            ref={closePickerAgent.ref}
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-sm text-base text-muted hover:text-txt"
            onClick={onClose}
            aria-label={t("common.close")}
            {...closePickerAgent.agentProps}
          >
            x
          </Button>
        </DialogHeader>
        <Input
          ref={searchAgent.ref}
          type="text"
          className="h-12 w-full rounded-none border-0 bg-transparent px-4 py-2.5 text-sm text-txt shadow-none focus-visible:ring-0 font-body"
          placeholder={t("secretsview.SearchByKeyDescr")}
          aria-label={t("secretsview.SearchByKeyDescr")}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          autoFocus
          {...searchAgent.agentProps}
        />
        <div className="flex-1 overflow-y-auto p-3">
          {available.length === 0 ? (
            <div className="rounded-sm border border-dashed border-border/60 py-6 text-center text-sm text-muted">
              {search
                ? "No matching secrets found."
                : "All available secrets are already in your vault."}
            </div>
          ) : (
            grouped.map(({ category, label, secrets }) => (
              <div key={category} className="mb-4 space-y-2">
                <div className="text-xs-tight font-semibold uppercase tracking-wide text-muted">
                  {label}
                </div>
                {secrets.map((s) => {
                  const enabledPlugins = s.usedBy.filter((u) => u.enabled);
                  const pluginList = s.usedBy
                    .map((u) => u.pluginName || u.pluginId)
                    .join(", ");
                  return (
                    <div
                      key={s.key}
                      className="flex items-start justify-between gap-3 rounded-sm border border-transparent px-3 py-2 hover:border-border/40 hover:bg-bg-hover"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-sm font-mono text-txt">
                          {s.key}
                        </div>
                        <div
                          className="text-xs-tight leading-5 text-muted"
                          title={pluginList}
                        >
                          {s.description}
                          {s.usedBy.length > 0 && (
                            <span className="ml-1">
                              —{" "}
                              {enabledPlugins.length > 0
                                ? `${enabledPlugins.length} active plugin${enabledPlugins.length !== 1 ? "s" : ""}`
                                : `${s.usedBy.length} plugin${s.usedBy.length !== 1 ? "s" : ""} (none active)`}
                            </span>
                          )}
                        </div>
                      </div>
                      <SecretPickerAddButton
                        secretKey={s.key}
                        label={t("common.add")}
                        onAdd={onAdd}
                      />
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SecretPickerAddButton({
  secretKey,
  label,
  onAdd,
}: {
  secretKey: string;
  label: string;
  onAdd: (key: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `picker-add-${slugifyKey(secretKey)}`,
    role: "button",
    label: `Add ${secretKey}`,
    group: "secrets-picker",
    description: `Add the ${secretKey} secret to the vault`,
    onActivate: () => onAdd(secretKey),
  });
  return (
    <Button
      ref={ref}
      variant="default"
      size="sm"
      className="px-2.5 py-1 h-7 text-xs flex-shrink-0"
      onClick={() => onAdd(secretKey)}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

/* ── Secret Card ────────────────────────────────────────────────────── */

function SecretCard({
  secret,
  draftValue,
  isVisible,
  isPinned,
  onToggleVisible,
  onDraftChange,
  onRemove,
}: {
  secret: SecretInfo;
  draftValue: string;
  isVisible: boolean;
  isPinned: boolean;
  onToggleVisible: () => void;
  onDraftChange: (val: string) => void;
  onRemove: () => void;
}) {
  const app = useApp() as ReturnType<typeof useApp> | undefined;
  const t = app?.t ?? fallbackTranslate;
  const enabledPlugins = secret.usedBy.filter((u) => u.enabled);
  const pluginList = secret.usedBy
    .map((u) => u.pluginName || u.pluginId)
    .join(", ");
  const hasDraft = draftValue.trim() !== "";

  // Only show "Required" if an enabled plugin actually requires it
  const showRequired = secret.required && enabledPlugins.length > 0;

  const slug = slugifyKey(secret.key);
  const valueAgent = useAgentElement<HTMLInputElement>({
    id: `secret-${slug}-value`,
    role: "text-input",
    label: secret.key,
    group: "secrets-fields",
    status: secret.isSet ? "active" : "inactive",
    description: `Enter a new value for the ${secret.key} secret`,
    getValue: () => draftValue,
    onFill: onDraftChange,
  });
  const visibilityAgent = useAgentElement<HTMLButtonElement>({
    id: `secret-${slug}-visibility`,
    role: "toggle",
    label: `${secret.key} value visibility`,
    group: "secrets-fields",
    status: isVisible ? "active" : "inactive",
    description: `Show or hide the ${secret.key} value`,
    onActivate: onToggleVisible,
  });
  const removeAgent = useAgentElement<HTMLButtonElement>({
    id: `secret-${slug}-remove`,
    role: "button",
    label: `Remove ${secret.key}`,
    group: "secrets-fields",
    description: `Remove the ${secret.key} secret from the vault`,
    onActivate: onRemove,
  });

  return (
    <div className="rounded-sm border border-border/50 bg-card/92 flex flex-col gap-3 p-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="h-2 w-2 flex-shrink-0 rounded-full"
              style={{
                backgroundColor: secret.isSet ? "var(--ok)" : "var(--muted)",
              }}
            />
            <span className="truncate text-sm font-mono font-medium text-txt">
              {secret.key}
            </span>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {showRequired && (
            <span className="rounded-sm border border-danger/35 bg-danger/10 px-1.5 py-0.5 text-2xs font-medium text-danger">
              {t("secretsview.Required")}
            </span>
          )}
          {/* Remove from vault — only if not set (set secrets always show) or if explicitly pinned */}
          {isPinned && !secret.isSet && (
            <Button
              ref={removeAgent.ref}
              variant="ghost"
              size="sm"
              className="h-7 rounded-sm px-2 text-xs-tight text-muted hover:bg-danger/10 hover:text-danger"
              onClick={onRemove}
              title={t("secretsview.RemoveFromVault")}
              {...removeAgent.agentProps}
            >
              x
            </Button>
          )}
        </div>
      </div>

      {/* Used by */}
      <div
        className="break-words text-xs-tight leading-5 text-muted"
        title={pluginList}
      >
        {enabledPlugins.length > 0
          ? `Used by ${enabledPlugins.length} active plugin${enabledPlugins.length !== 1 ? "s" : ""}: ${enabledPlugins.map((u) => u.pluginName || u.pluginId).join(", ")}`
          : `Available for: ${pluginList}`}
      </div>

      {/* Current value */}
      {secret.isSet && !hasDraft && (
        <div className="rounded-sm border border-border/50 bg-bg px-2 py-1 text-xs font-mono text-muted">
          {secret.maskedValue}
        </div>
      )}

      {/* Input */}
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <Input
          ref={valueAgent.ref}
          type={isVisible ? "text" : "password"}
          className="h-9 flex-1 border-border/60 bg-bg px-2.5 py-1.5 text-sm font-mono text-txt focus-visible:border-accent/50 focus-visible:ring-1 focus-visible:ring-accent/30"
          placeholder={
            secret.isSet ? "Enter new value to update" : "Enter value"
          }
          value={draftValue}
          onChange={(e) => onDraftChange(e.target.value)}
          {...valueAgent.agentProps}
        />
        <Button
          ref={visibilityAgent.ref}
          variant="outline"
          size="sm"
          className="h-9 px-3 text-xs text-muted-strong hover:text-txt"
          onClick={onToggleVisible}
          title={isVisible ? "Hide" : "Show"}
          {...visibilityAgent.agentProps}
        >
          {isVisible ? "Hide" : "Show"}
        </Button>
      </div>
    </div>
  );
}
