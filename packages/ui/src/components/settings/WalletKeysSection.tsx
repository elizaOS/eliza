/**
 * Wallet keys panel for Settings -> Wallet & RPC.
 *
 * Single source of truth: `/api/secrets/inventory?category=wallet`.
 * Reveal / delete go through the same `/api/secrets/inventory/:key`
 * endpoints the Vault tab uses, so toggling a value here shows up
 * immediately in Settings -> Vault and vice versa.
 *
 * Scope: lists wallet-category vault entries (EVM_PRIVATE_KEY,
 * SOLANA_PRIVATE_KEY, per-agent `agent.<id>.wallet.<chain>`) with a
 * reveal-on-demand value display and an "Add wallet key" form.
 *
 * Per-agent address derivation is read from the entry's reveal payload
 * (the per-agent storage shape is JSON with `{address, privateKey}`),
 * so the panel doesn't need to bundle a key-derivation library on the
 * client.
 */

import { Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { isVaultEntryMeta, type VaultEntryMeta } from "./vault-tabs/types";

interface RevealPayload {
  ok: boolean;
  value: string;
  source: "bare" | "profile";
  profileId?: string;
}

function maskValue(value: string): string {
  if (value.length <= 12) return "*".repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function tryExtractAgentAddress(rawValue: string): string | null {
  // Per-agent wallet entries store JSON `{ chain, address, privateKey, ... }`.
  // Bare main-wallet entries store the raw private key as a hex/base58 string
  // (no JSON wrapper).
  if (!rawValue.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(rawValue) as { address?: unknown };
    if (typeof parsed.address === "string" && parsed.address.length > 0) {
      return parsed.address;
    }
  } catch {
    // Not JSON — fall through.
  }
  return null;
}

function entryDisplayLabel(meta: VaultEntryMeta): string {
  if (meta.label && meta.label !== meta.key) return meta.label;
  // Make the per-agent agent.<id>.wallet.<chain> shape human-friendly.
  const parts = meta.key.split(".");
  if (parts.length === 4 && parts[0] === "agent" && parts[2] === "wallet") {
    const agentId = decodeURIComponent(parts[1] ?? "");
    return `${agentId} (${parts[3]})`;
  }
  return meta.key;
}

export function WalletKeysSection() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<VaultEntryMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealMap, setRevealMap] = useState<Record<string, string>>({});
  const [revealLoading, setRevealLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [showAdd, setShowAdd] = useState(false);
  const [addKey, setAddKey] = useState("");
  const [addValue, setAddValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { ref: addToggleRef, agentProps: addToggleAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "wallet-keys-add-toggle",
      role: "button",
      label: "Add wallet key",
      group: "wallet-keys",
      description: "Show the form to add a wallet private key",
    });
  const { ref: addKeyRef, agentProps: addKeyAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "wallet-keys-key-name",
      role: "text-input",
      label: "Wallet key name",
      group: "wallet-keys-add",
      description: "Env-var name like EVM_PRIVATE_KEY",
      getValue: () => addKey,
      onFill: (v) => setAddKey(v),
    });
  const { ref: addValueRef, agentProps: addValueAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "wallet-keys-private-key",
      role: "text-input",
      label: "Wallet private key value",
      group: "wallet-keys-add",
      getValue: () => addValue,
      onFill: (v) => setAddValue(v),
    });
  const { ref: addCancelRef, agentProps: addCancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "wallet-keys-cancel",
      role: "button",
      label: "Cancel adding wallet key",
      group: "wallet-keys-add",
      onActivate: () => setShowAdd(false),
    });
  const { ref: addSaveRef, agentProps: addSaveAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "wallet-keys-save",
      role: "button",
      label: "Save wallet key",
      group: "wallet-keys-add",
    });

  const load = useCallback(async () => {
    setError(null);
    setEntries(null);
    try {
      const res = await fetch("/api/secrets/inventory?category=wallet");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { entries?: unknown };
      if (!Array.isArray(json.entries)) {
        throw new Error("Invalid wallet inventory response");
      }
      if (!json.entries.every(isVaultEntryMeta)) {
        throw new Error("Invalid wallet inventory entry shape");
      }
      setEntries(json.entries);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("walletkeys.loadFailed", { defaultValue: "load failed" }),
      );
      setEntries([]);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onReveal = useCallback(
    async (key: string) => {
      setRevealLoading((prev) => ({ ...prev, [key]: true }));
      try {
        const res = await fetch(
          `/api/secrets/inventory/${encodeURIComponent(key)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as RevealPayload;
        setRevealMap((prev) => ({ ...prev, [key]: json.value }));
        // Auto-hide after 10s (matches the Vault tab's reveal lifecycle).
        window.setTimeout(() => {
          setRevealMap((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }, 10_000);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("walletkeys.revealFailed", { defaultValue: "reveal failed" }),
        );
      } finally {
        setRevealLoading((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [t],
  );

  const onHide = useCallback((key: string) => {
    setRevealMap((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const onDelete = useCallback(
    async (entry: VaultEntryMeta) => {
      const ok = window.confirm(
        t("walletkeys.deleteConfirm", {
          key: entry.key,
          defaultValue: 'Delete wallet key "{{key}}"? This cannot be undone.',
        }),
      );
      if (!ok) return;
      const res = await fetch(
        `/api/secrets/inventory/${encodeURIComponent(entry.key)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      await load();
    },
    [load, t],
  );

  const onAdd = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const key = addKey.trim();
      const value = addValue.trim();
      if (!key || !value) return;
      setSubmitting(true);
      setError(null);
      const res = await fetch(
        `/api/secrets/inventory/${encodeURIComponent(key)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value,
            category: "wallet",
          }),
        },
      );
      setSubmitting(false);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      setAddKey("");
      setAddValue("");
      setShowAdd(false);
      await load();
    },
    [addKey, addValue, load],
  );

  return (
    <section data-testid="wallet-keys-section" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-txt">
            {t("walletkeys.title", { defaultValue: "Wallet keys" })}
          </p>
          <p className="text-2xs text-muted">
            {t("walletkeys.description", {
              defaultValue:
                'Private keys stored in the local vault. Same data the Vault tab shows under "Wallet" — edit either place.',
            })}
          </p>
        </div>
        <Button
          ref={addToggleRef}
          {...addToggleAgentProps}
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1 rounded-sm px-2"
          onClick={() => setShowAdd((v) => !v)}
          data-testid="wallet-keys-add-toggle"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("walletkeys.addKey", { defaultValue: "Add wallet key" })}
        </Button>
      </div>

      {error && (
        <div
          aria-live="polite"
          data-testid="wallet-keys-error"
          className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger"
        >
          {error}
        </div>
      )}

      {showAdd && (
        <form
          onSubmit={onAdd}
          className="space-y-2 rounded-sm border border-border/50 bg-card/30 p-2"
          data-testid="wallet-keys-add-form"
        >
          <p className="text-2xs text-muted">
            {t("walletkeys.addFormLeadIn", {
              defaultValue:
                "Stored sensitively in the encrypted vault. Use the env-var name (e.g.",
            })}{" "}
            <code>EVM_PRIVATE_KEY</code>, <code>SOLANA_PRIVATE_KEY</code>
            {") "}
            {t("walletkeys.addFormTrailing", {
              defaultValue: "so other surfaces pick it up automatically.",
            })}
          </p>
          <div>
            <Label className="text-2xs text-muted">
              {t("walletkeys.keyName", { defaultValue: "Key name" })}
            </Label>
            <Input
              ref={addKeyRef}
              {...addKeyAgentProps}
              value={addKey}
              onChange={(e) => setAddKey(e.target.value)}
              placeholder="EVM_PRIVATE_KEY"
              className="h-8 text-xs"
              autoComplete="off"
              required
            />
          </div>
          <div>
            <Label className="text-2xs text-muted">
              {t("walletkeys.privateKey", { defaultValue: "Private key" })}
            </Label>
            <Input
              ref={addValueRef}
              {...addValueAgentProps}
              type="password"
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              className="h-8 text-xs"
              autoComplete="new-password"
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              ref={addCancelRef}
              {...addCancelAgentProps}
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 rounded-sm px-3 text-xs"
              onClick={() => setShowAdd(false)}
              disabled={submitting}
            >
              {t("walletkeys.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              ref={addSaveRef}
              {...addSaveAgentProps}
              type="submit"
              variant="default"
              size="sm"
              className="h-7 gap-1 rounded-sm px-3 text-xs"
              disabled={submitting || !addKey.trim() || !addValue.trim()}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  {t("walletkeys.saving", { defaultValue: "Saving…" })}
                </>
              ) : (
                t("walletkeys.save", { defaultValue: "Save" })
              )}
            </Button>
          </div>
        </form>
      )}

      {entries === null ? (
        <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />{" "}
          {t("walletkeys.loading", { defaultValue: "Loading…" })}
        </div>
      ) : entries.length === 0 ? (
        <div
          data-testid="wallet-keys-empty"
          className="rounded-sm border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted"
        >
          {t("walletkeys.empty", {
            defaultValue:
              "No wallet keys yet. Add one with the button above, or generate one per agent from the Agents page.",
          })}
        </div>
      ) : (
        <ul
          data-testid="wallet-keys-list"
          className="space-y-1 rounded-sm border border-border/40 bg-card/30 p-1"
        >
          {entries.map((entry) => {
            const revealed = revealMap[entry.key];
            const loading = revealLoading[entry.key];
            const address = revealed ? tryExtractAgentAddress(revealed) : null;
            return (
              <WalletKeyRow
                key={entry.key}
                entryKey={entry.key}
                displayLabel={entryDisplayLabel(entry)}
                secondaryLine={
                  revealed
                    ? address
                      ? t("walletkeys.address", {
                          address,
                          defaultValue: "address: {{address}}",
                        })
                      : maskValue(revealed)
                    : entry.key
                }
                revealed={Boolean(revealed)}
                loading={Boolean(loading)}
                onToggleReveal={() =>
                  revealed ? onHide(entry.key) : void onReveal(entry.key)
                }
                onDelete={() => void onDelete(entry)}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function WalletKeyRow({
  entryKey,
  displayLabel,
  secondaryLine,
  revealed,
  loading,
  onToggleReveal,
  onDelete,
}: {
  entryKey: string;
  displayLabel: string;
  secondaryLine: string;
  revealed: boolean;
  loading: boolean;
  onToggleReveal: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { ref: revealRef, agentProps: revealAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `wallet-keys-reveal-${entryKey}`,
      role: "button",
      label: `${revealed ? "Hide" : "Reveal"} ${displayLabel}`,
      group: "wallet-keys",
      description: `Reveal or hide the value for ${entryKey}`,
      status: revealed ? "active" : "inactive",
      onActivate: onToggleReveal,
    });
  const { ref: deleteRef, agentProps: deleteAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `wallet-keys-delete-${entryKey}`,
      role: "button",
      label: `Delete ${displayLabel}`,
      group: "wallet-keys",
      onActivate: onDelete,
    });
  return (
    <li className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-bg-muted/30">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-txt">{displayLabel}</p>
        <p className="truncate font-mono text-2xs text-muted">
          {secondaryLine}
        </p>
      </div>
      <Button
        ref={revealRef}
        {...revealAgentProps}
        variant="ghost"
        size="sm"
        className="h-7 w-7 shrink-0 rounded-sm p-0 text-muted hover:text-txt"
        aria-label={
          revealed
            ? t("walletkeys.hide", {
                key: entryKey,
                defaultValue: "Hide {{key}}",
              })
            : t("walletkeys.reveal", {
                key: entryKey,
                defaultValue: "Reveal {{key}}",
              })
        }
        onClick={onToggleReveal}
        disabled={loading}
        data-testid={`wallet-keys-reveal-${entryKey}`}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : revealed ? (
          <EyeOff className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Eye className="h-3.5 w-3.5" aria-hidden />
        )}
      </Button>
      <Button
        ref={deleteRef}
        {...deleteAgentProps}
        variant="ghost"
        size="sm"
        className="h-7 w-7 shrink-0 rounded-sm p-0 text-muted hover:text-danger"
        aria-label={t("walletkeys.delete", {
          key: entryKey,
          defaultValue: "Delete {{key}}",
        })}
        onClick={onDelete}
        data-testid={`wallet-keys-delete-${entryKey}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </li>
  );
}
