/**
 * Secrets Vault — user-curated view of API keys and credentials.
 *
 * Only shows secrets the user has explicitly added to their vault (persisted in
 * localStorage) plus any that are already set in the environment. Users browse
 * available secrets from plugins and pick which ones to manage here.
 */

import { Button, Input } from "@elizaos/ui";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SecretInfo } from "../api";
import { client } from "../api";
import { useApp } from "../state";

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
    /* ignore */
  }
  return new Set();
}

function savePinnedKeys(keys: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    /* ignore */
  }
}

/* ── Component ──────────────────────────────────────────────────────── */

export function SecretsView() {
  const { t } = useApp();
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

  if (loading) {
    return (
      <div className="text-[var(--muted)] text-[13px] italic py-8 text-center">
        {t("secretsview.LoadingSecrets")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-[var(--danger)] text-[13px] mb-2">{error}</p>
        <button
          type="button"
          className="bg-transparent border-0 text-[13px] text-[var(--text)] underline decoration-[var(--accent)] underline-offset-2 cursor-pointer hover:opacity-80"
          onClick={load}
        >
          {t("common.retry")}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <p className="text-[13px] text-[var(--muted)] m-0">
          {t("secretsview.ManageAPIKeysAnd")}
        </p>
        <Button
          variant="default"
          size="sm"
          className="px-3 py-1.5 h-8 text-[13px] shadow-sm flex-shrink-0"
          onClick={() => {
            setPickerOpen(true);
            setPickerSearch("");
          }}
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
        <div className="text-[var(--muted)] text-[13px] italic py-8 text-center border border-dashed border-[var(--border)]">
          {t("secretsview.YourVaultIsEmpty")}
        </div>
      )}

      {/* Vault secrets grouped by category */}
      {grouped.map(({ category, label, secrets: catSecrets }) => (
        <div key={category} className="mb-6">
          <button
            type="button"
            className="flex items-center gap-2 w-full bg-transparent border-0 cursor-pointer text-left mb-3"
            onClick={() => toggleCollapse(category)}
          >
            <ChevronDown
              className="w-3 h-3 text-[var(--muted)] select-none transition-transform"
              style={{
                transform: collapsed.has(category)
                  ? "rotate(-90deg)"
                  : "rotate(0deg)",
              }}
            />
            <span className="text-[14px] font-semibold text-[var(--txt)]">
              {label}
            </span>
            <span className="text-[12px] text-[var(--muted)]">
              ({catSecrets.length})
            </span>
          </button>

          {!collapsed.has(category) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
        </div>
      ))}

      {/* Save bar */}
      {vaultSecrets.length > 0 && (
        <div className="flex items-center gap-3 mt-4 pt-4 border-t border-[var(--border)]">
          <Button
            variant="default"
            size="sm"
            className="px-4 py-2 h-9 text-[13px] font-medium shadow-sm transition-colors"
            disabled={dirtyKeys.length === 0 || saving}
            onClick={handleSave}
          >
            {saving
              ? "Saving..."
              : `Save${dirtyKeys.length > 0 ? ` (${dirtyKeys.length})` : ""}`}
          </Button>
          {saveResult && (
            <span
              className={`text-[13px] ${saveResult.ok ? "text-[var(--ok)]" : "text-[var(--danger)]"}`}
            >
              {saveResult.message}
            </span>
          )}
        </div>
      )}
    </div>
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
  const { t } = useApp();
  // Group available by category
  const grouped = useMemo(() => {
    return groupSecretsByCategory(available);
  }, [available]);

  return (
    <div
      className="fixed inset-0 bg-black/40 z-[9999] flex items-start justify-center pt-20"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-[var(--bg)] border border-[var(--border)] w-[560px] max-h-[480px] flex flex-col shadow-2xl">
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
          <span className="text-[14px] font-semibold text-[var(--txt)]">
            {t("secretsview.AddSecretsToVault")}
          </span>
          <button
            type="button"
            className="text-[var(--muted)] bg-transparent border-0 cursor-pointer text-[16px] hover:text-[var(--txt)]"
            onClick={onClose}
          >
            x
          </button>
        </div>
        <Input
          type="text"
          className="w-full px-4 py-2.5 h-12 border-0 border-b border-[var(--border)] bg-transparent text-[13px] text-[var(--txt)] shadow-none rounded-none focus-visible:ring-0 font-body"
          placeholder={t("secretsview.SearchByKeyDescr")}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <div className="flex-1 overflow-y-auto p-3">
          {available.length === 0 ? (
            <div className="py-6 text-center text-[var(--muted)] text-[13px]">
              {search
                ? "No matching secrets found."
                : "All available secrets are already in your vault."}
            </div>
          ) : (
            grouped.map(({ category, label, secrets }) => (
              <div key={category} className="mb-4">
                <div className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wide mb-2">
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
                      className="flex items-center justify-between py-2 px-2 hover:bg-[var(--bg-hover)] gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-mono text-[var(--txt)]">
                          {s.key}
                        </div>
                        <div
                          className="text-[11px] text-[var(--muted)] truncate"
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
                      <Button
                        variant="default"
                        size="sm"
                        className="px-2.5 py-1 h-7 text-[12px] shadow-sm flex-shrink-0"
                        onClick={() => onAdd(s.key)}
                      >
                        {t("secretsview.Add")}
                      </Button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
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
  const { t } = useApp();
  const enabledPlugins = secret.usedBy.filter((u) => u.enabled);
  const pluginList = secret.usedBy
    .map((u) => u.pluginName || u.pluginId)
    .join(", ");
  const hasDraft = draftValue.trim() !== "";

  // Only show "Required" if an enabled plugin actually requires it
  const showRequired = secret.required && enabledPlugins.length > 0;

  return (
    <div className="border border-[var(--border)] bg-[var(--bg-card)] p-4 flex flex-col gap-2">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{
                backgroundColor: secret.isSet ? "var(--ok)" : "var(--muted)",
              }}
            />
            <span className="text-[13px] font-mono font-medium text-[var(--txt)] truncate">
              {secret.key}
            </span>
          </div>
          <p className="text-[12px] text-[var(--muted)] mt-1 leading-snug">
            {secret.description}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {showRequired && (
            <span className="text-[10px] text-[var(--danger)] font-medium px-1.5 py-0.5 border border-[var(--danger)] rounded">
              {t("secretsview.Required")}
            </span>
          )}
          {/* Remove from vault — only if not set (set secrets always show) or if explicitly pinned */}
          {isPinned && !secret.isSet && (
            <button
              type="button"
              className="text-[11px] text-[var(--muted)] bg-transparent border-0 cursor-pointer hover:text-[var(--danger)]"
              onClick={onRemove}
              title={t("secretsview.RemoveFromVault")}
            >
              x
            </button>
          )}
        </div>
      </div>

      {/* Used by */}
      <div className="text-[11px] text-[var(--muted)]" title={pluginList}>
        {enabledPlugins.length > 0
          ? `Used by ${enabledPlugins.length} active plugin${enabledPlugins.length !== 1 ? "s" : ""}: ${enabledPlugins.map((u) => u.pluginName || u.pluginId).join(", ")}`
          : `Available for: ${pluginList}`}
      </div>

      {/* Current value */}
      {secret.isSet && !hasDraft && (
        <div className="text-[12px] font-mono text-[var(--muted)] bg-[var(--bg)] px-2 py-1 rounded">
          {secret.maskedValue}
        </div>
      )}

      {/* Input */}
      <div className="flex gap-1.5 items-center">
        <Input
          type={isVisible ? "text" : "password"}
          className="flex-1 px-2.5 py-1.5 h-8 text-[13px] font-mono bg-[var(--bg)] border border-[var(--border)] text-[var(--txt)] focus-visible:ring-1 focus-visible:ring-[var(--accent)] focus-visible:border-[var(--accent)]"
          placeholder={
            secret.isSet ? "Enter new value to update" : "Enter value"
          }
          value={draftValue}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          className="px-2 py-1.5 h-8 text-[12px] bg-[var(--bg)] text-[var(--muted)] hover:text-[var(--txt)] shadow-sm"
          onClick={onToggleVisible}
          title={isVisible ? "Hide" : "Show"}
        >
          {isVisible ? "Hide" : "Show"}
        </Button>
      </div>
    </div>
  );
}
