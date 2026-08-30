/**
 * Wallet keys panel for Settings -> Wallet & RPC.
 *
 * Single source of truth: `/api/secrets/inventory?category=wallet`. Reveal /
 * delete go through the same `/api/secrets/inventory/:key` endpoints the Vault
 * tab uses, so changes here show up immediately in Settings -> Vault.
 */

import { Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAgentElement } from "../../agent-surface";
// All requests go through the shared client (never bare `fetch`) so they hit
// the configured apiBase and carry the injected auth token — a bare relative
// fetch targets the page origin unauthenticated, which breaks remote/token-
// authed runtimes (e.g. the Android local agent).
import { client } from "../../api/client";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { OwnerOnlyNotice, RoleGate } from "../RoleGate";
import { Button } from "../ui/button";
import { SettingsInputRow } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";
import { isVaultEntryMeta, type VaultEntryMeta } from "./vault-tabs/types";

type Translate = (key: string, values?: Record<string, unknown>) => string;

interface RevealPayload {
  ok: boolean;
  value: string;
  source: "bare" | "profile";
  profileId?: string;
}

interface PublicWalletAddresses {
  evmAddress: string | null;
  solanaAddress: string | null;
}

function normalizePublicAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  return address.length > 0 ? address : null;
}

function parsePublicWalletAddresses(
  value: unknown,
): PublicWalletAddresses | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  return {
    evmAddress: normalizePublicAddress(payload.evmAddress),
    solanaAddress: normalizePublicAddress(payload.solanaAddress),
  };
}

function maskValue(value: string): string {
  if (value.length <= 12) return "*".repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * Turn a raw HTTP failure into plain-language recovery copy (#13453): the audit
 * flagged bare `HTTP 502` / `HTTP 500` leaking into the wallet keys panel as
 * "raw infrastructure leakage in a preferences view". Map the status to an
 * action-oriented sentence a non-engineer can act on; keep the raw status in
 * parentheses so a developer can still diagnose. `verb` names the action that
 * failed ("load", "reveal", "save", "delete") so one helper serves every site.
 */
function describeHttpError(status: number, verb: string, t: Translate): string {
  if (status === 401 || status === 403) {
    return t("walletkeys.err.unauthorized", {
      status,
      defaultValue:
        "You do not have permission to manage wallet keys here. (HTTP {{status}})",
    });
  }
  if (status === 429) {
    return t("walletkeys.err.rateLimited", {
      status,
      defaultValue:
        "Too many requests. Wait a moment and try again. (HTTP {{status}})",
    });
  }
  if (status >= 500) {
    return t("walletkeys.err.serverDown", {
      verb,
      status,
      defaultValue:
        "Couldn't {{verb}} wallet keys. The vault service is unavailable. Try again shortly. (HTTP {{status}})",
    });
  }
  return t("walletkeys.err.generic", {
    verb,
    status,
    defaultValue: "Couldn't {{verb}} wallet keys. Try again. (HTTP {{status}})",
  });
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

function walletChainDisplayName(chain: string): string {
  switch (chain.toLowerCase()) {
    case "evm":
      return "EVM";
    case "sol":
    case "solana":
      return "Solana";
    default:
      return chain;
  }
}

function parseAgentWalletKey(key: string): {
  encodedAgentId: string;
  chain: string;
} | null {
  const parts = key.split(".");
  if (parts.length !== 4 || parts[0] !== "agent" || parts[2] !== "wallet") {
    return null;
  }
  return {
    encodedAgentId: parts[1] ?? "",
    chain: parts[3] ?? "",
  };
}

function normalizeAgentWalletLabel(label: string): string {
  const match = /^(.*)\s+\((evm|sol|solana)\)$/i.exec(label);
  if (!match) return label;
  return `${match[1]} · ${walletChainDisplayName(match[2] ?? "")}`;
}

function publicAddressForEntry(
  meta: VaultEntryMeta,
  addresses: PublicWalletAddresses | null,
): string | null {
  if (!addresses) return null;
  const walletKey = parseAgentWalletKey(meta.key);
  if (!walletKey) return null;
  switch (walletKey.chain.toLowerCase()) {
    case "evm":
      return addresses.evmAddress;
    case "solana":
      return addresses.solanaAddress;
    default:
      return null;
  }
}

export function entryDisplayLabel(meta: VaultEntryMeta): string {
  if (meta.label && meta.label !== meta.key) {
    return normalizeAgentWalletLabel(meta.label);
  }
  // Make the per-agent agent.<id>.wallet.<chain> shape human-friendly.
  const walletKey = parseAgentWalletKey(meta.key);
  if (walletKey) {
    try {
      return `agent ${decodeURIComponent(walletKey.encodedAgentId)} · ${walletChainDisplayName(walletKey.chain)}`;
    } catch {
      // error-policy:J4 An invalid persisted key is shown as explicitly
      // unavailable instead of exposing its malformed segment as an agent.
      return `Unavailable agent · ${walletChainDisplayName(walletKey.chain)}`;
    }
  }
  return meta.key;
}

export function entryDisplayDescription(meta: VaultEntryMeta): string {
  const walletKey = parseAgentWalletKey(meta.key);
  if (!walletKey) return meta.key;
  return `${walletChainDisplayName(walletKey.chain)} wallet key`;
}

/**
 * Wallet private keys are an OWNER-tier surface (#12087 Item 24): only the
 * workspace owner may view or manage them. The gate is applied at the surface
 * boundary via the canonical {@link RoleGate}, so the whole body — including its
 * loading/error branches — is owner-gated in one place.
 */
export function WalletKeysSection() {
  return (
    <RoleGate minRole="OWNER" fallback={<OwnerOnlyNotice />}>
      <WalletKeysSectionBody />
    </RoleGate>
  );
}

function WalletKeysSectionBody() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<VaultEntryMeta[] | null>(null);
  const [publicAddresses, setPublicAddresses] =
    useState<PublicWalletAddresses | null>(null);
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
      const res = await client.rawRequest(
        "/api/secrets/inventory?category=wallet",
        undefined,
        { allowNonOk: true },
      );
      if (res.status === 404) {
        // Secrets/vault route not mounted on this surface (e.g. the mobile
        // agent) — show the empty "no wallet keys" state, not a raw red
        // "HTTP 404" error banner.
        setEntries([]);
        return;
      }
      if (!res.ok) throw new Error(describeHttpError(res.status, "load", t));
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

  const loadPublicAddresses = useCallback(async () => {
    try {
      const res = await client.rawRequest("/api/wallet/addresses", undefined, {
        allowNonOk: true,
      });
      if (!res.ok) return;
      const addresses = parsePublicWalletAddresses(await res.json());
      if (addresses) setPublicAddresses(addresses);
    } catch {
      // error-policy:J4 Public addresses are optional metadata. A runtime
      // without the wallet route still gets the complete vault-key surface and
      // its safe fallback descriptions; this never becomes a settings error.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPublicAddresses();
  }, [load, loadPublicAddresses]);

  const onReveal = useCallback(
    async (key: string) => {
      setRevealLoading((prev) => ({ ...prev, [key]: true }));
      try {
        const res = await client.rawRequest(
          `/api/secrets/inventory/${encodeURIComponent(key)}`,
          undefined,
          { allowNonOk: true },
        );
        if (!res.ok)
          throw new Error(describeHttpError(res.status, "reveal", t));
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
      const res = await client.rawRequest(
        `/api/secrets/inventory/${encodeURIComponent(entry.key)}`,
        { method: "DELETE" },
        { allowNonOk: true },
      );
      if (!res.ok) {
        setError(describeHttpError(res.status, "delete", t));
        return;
      }
      await load();
    },
    // Includes `t` because `describeHttpError` closes over it via the error copy.
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
      const res = await client.rawRequest(
        `/api/secrets/inventory/${encodeURIComponent(key)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value,
            category: "wallet",
          }),
        },
        { allowNonOk: true },
      );
      setSubmitting(false);
      if (!res.ok) {
        setError(describeHttpError(res.status, "save", t));
        return;
      }
      setAddKey("");
      setAddValue("");
      setShowAdd(false);
      await load();
    },
    // Includes `t` because `describeHttpError` closes over it via the error copy.
    [addKey, addValue, load, t],
  );

  return (
    <SettingsStack data-testid="wallet-keys-section" className="gap-2.5">
      <SettingsGroup
        bare
        title={t("walletkeys.title", { defaultValue: "Wallet keys" })}
        action={
          <Button
            ref={addToggleRef}
            {...addToggleAgentProps}
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setShowAdd((v) => !v)}
            data-testid="wallet-keys-add-toggle"
          >
            <Plus className="size-3.5" aria-hidden />
            {t("walletkeys.addKey", { defaultValue: "Add wallet key" })}
          </Button>
        }
      />

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
          className="space-y-2 pt-1"
          data-testid="wallet-keys-add-form"
        >
          <SettingsInputRow
            agentId="wallet-keys-key-name"
            agentLabel="Wallet key name"
            group="wallet-keys-add"
            label={t("walletkeys.keyName", { defaultValue: "Key name" })}
            description={t("walletkeys.keyNameHint", {
              defaultValue: "Env-var name like EVM_PRIVATE_KEY",
            })}
            value={addKey}
            onValueChange={setAddKey}
            placeholder="EVM_PRIVATE_KEY"
            autoComplete="off"
          />
          <SettingsInputRow
            agentId="wallet-keys-private-key"
            agentLabel="Wallet private key value"
            group="wallet-keys-add"
            label={t("walletkeys.privateKey", { defaultValue: "Private key" })}
            type="password"
            value={addValue}
            onValueChange={setAddValue}
            autoComplete="new-password"
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button
              ref={addCancelRef}
              {...addCancelAgentProps}
              type="button"
              variant="ghost"
              size="touch"
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
              size="touch"
              disabled={submitting || !addKey.trim() || !addValue.trim()}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
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
          <Loader2 className="size-3.5 animate-spin" aria-hidden />{" "}
          {t("walletkeys.loading", { defaultValue: "Loading…" })}
        </div>
      ) : entries.length === 0 ? (
        <p
          data-testid="wallet-keys-empty"
          className="px-1 py-3 text-xs text-muted"
        >
          {t("walletkeys.empty", {
            defaultValue: "No wallet keys yet.",
          })}
        </p>
      ) : (
        <SettingsGroup data-testid="wallet-keys-list">
          {entries.map((entry) => {
            const revealed = revealMap[entry.key];
            const loading = revealLoading[entry.key];
            const revealedAddress = revealed
              ? tryExtractAgentAddress(revealed)
              : null;
            const publicAddress = publicAddressForEntry(entry, publicAddresses);
            return (
              <WalletKeyRow
                key={entry.key}
                entryKey={entry.key}
                displayLabel={entryDisplayLabel(entry)}
                secondaryLine={
                  publicAddress ??
                  (revealed
                    ? revealedAddress
                      ? t("walletkeys.address", {
                          address: revealedAddress,
                          defaultValue: "address: {{address}}",
                        })
                      : maskValue(revealed)
                    : entryDisplayDescription(entry))
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
        </SettingsGroup>
      )}
    </SettingsStack>
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
    <SettingsRow
      label={<span className="truncate">{displayLabel}</span>}
      description={
        <span className="block truncate font-mono">{secondaryLine}</span>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-1">
          <Button
            ref={revealRef}
            {...revealAgentProps}
            variant="ghost"
            size="icon-lg"
            className="shrink-0"
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
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : revealed ? (
              <EyeOff className="size-4" aria-hidden />
            ) : (
              <Eye className="size-4" aria-hidden />
            )}
          </Button>
          <Button
            ref={deleteRef}
            {...deleteAgentProps}
            variant="destructive"
            size="icon-lg"
            className="shrink-0"
            aria-label={t("walletkeys.delete", {
              key: entryKey,
              defaultValue: "Delete {{key}}",
            })}
            onClick={onDelete}
            data-testid={`wallet-keys-delete-${entryKey}`}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </span>
      }
    />
  );
}
