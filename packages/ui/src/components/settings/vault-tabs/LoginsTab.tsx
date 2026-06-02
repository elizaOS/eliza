/**
 * Logins tab — saved-logins list (in-house + 1Password + Bitwarden) with
 * the in-house "Add login" form. Per-source rows; external rows are
 * read-only links back to the password manager.
 *
 * Extracted from the original `SecretsManagerSection.tsx` `SavedLoginsPanel`.
 */

import { Bot, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAgentElement } from "../../../agent-surface";
import { useTranslation } from "../../../state/TranslationContext";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import type {
  SavedLogin,
  SavedLoginSource,
  SavedLoginsListFailure,
} from "./types";

const SOURCE_LABEL: Record<SavedLoginSource, string> = {
  "in-house": "Local",
  "1password": "1Password",
  bitwarden: "Bitwarden",
};

const SOURCE_PILL_CLASS: Record<SavedLoginSource, string> = {
  "in-house": "border-accent/40 bg-accent/10 text-accent",
  "1password": "border-info/40 bg-info/10 text-info",
  bitwarden: "border-warn/40 bg-warn/10 text-warn",
};

function relativeAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const elapsed = Date.now() - ms;
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export function LoginsTab() {
  const { t } = useTranslation();
  const sourceLabel = useCallback(
    (source: SavedLoginSource): string =>
      source === "in-house"
        ? t("logins.source.local", { defaultValue: "Local" })
        : SOURCE_LABEL[source],
    [t],
  );
  const [logins, setLogins] = useState<SavedLogin[] | null>(null);
  const [failures, setFailures] = useState<SavedLoginsListFailure[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addDomain, setAddDomain] = useState("");
  const [addUsername, setAddUsername] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState("");
  // Per-domain "agent may autofill without prompting" map. Backed by
  // `creds.<domain>.:autoallow` in the vault — the same flag the
  // user-driven autofill consent path uses, and the only authorization
  // the BROWSER action (autofill-login subaction) will accept.
  const [autoallowMap, setAutoallowMap] = useState<Record<string, boolean>>({});

  const { ref: addLoginRef, agentProps: addLoginAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "logins-add-toggle",
      role: "button",
      label: "Add login",
      group: "logins",
      description: "Show the form to add a saved login",
    });
  const { ref: addDomainRef, agentProps: addDomainAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "logins-add-domain",
      role: "text-input",
      label: "Login domain",
      group: "logins-add",
      getValue: () => addDomain,
      onFill: (v) => setAddDomain(v),
    });
  const { ref: addUsernameRef, agentProps: addUsernameAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "logins-add-username",
      role: "text-input",
      label: "Login username or email",
      group: "logins-add",
      getValue: () => addUsername,
      onFill: (v) => setAddUsername(v),
    });
  const { ref: addPasswordRef, agentProps: addPasswordAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "logins-add-password",
      role: "text-input",
      label: "Login password",
      group: "logins-add",
      getValue: () => addPassword,
      onFill: (v) => setAddPassword(v),
    });
  const { ref: addCancelRef, agentProps: addCancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "logins-add-cancel",
      role: "button",
      label: "Cancel adding login",
      group: "logins-add",
      onActivate: () => setShowAdd(false),
    });
  const { ref: addSaveRef, agentProps: addSaveAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "logins-add-save",
      role: "button",
      label: "Save login",
      group: "logins-add",
    });
  const { ref: filterRef, agentProps: filterAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "logins-filter",
      role: "text-input",
      label: "Filter saved logins",
      group: "logins",
      getValue: () => filter,
      onFill: (v) => setFilter(v),
    });

  const loadAutoallowFor = useCallback(
    async (domains: ReadonlyArray<string>) => {
      const next: Record<string, boolean> = {};
      // Single-flight: one fetch per unique domain. Domains are usually
      // <50 in a saved-logins list, well under any rate concern.
      // Per-domain failures default to false (never autoallow on a
      // missing read) and are not surfaced to the error banner — the
      // toggle row falls back to "off" silently rather than blocking
      // the rest of the UI.
      const unique = Array.from(new Set(domains.filter(Boolean)));
      const responses = await Promise.all(
        unique.map(async (d): Promise<readonly [string, boolean]> => {
          const res = await fetch(
            `/api/secrets/logins/${encodeURIComponent(d)}/autoallow`,
          );
          if (!res.ok) return [d, false] as const;
          const json = (await res.json()) as {
            ok?: boolean;
            allowed?: boolean;
          };
          return [d, json?.allowed === true] as const;
        }),
      );
      for (const [d, allowed] of responses) next[d] = allowed;
      setAutoallowMap(next);
    },
    [],
  );

  const load = useCallback(async () => {
    setError(null);
    setLogins(null);
    try {
      const res = await fetch("/api/secrets/logins");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        logins: SavedLogin[];
        failures?: SavedLoginsListFailure[];
      };
      setLogins(json.logins);
      setFailures(json.failures ?? []);
      const domains = json.logins
        .map((l) => l.domain)
        .filter((d): d is string => typeof d === "string" && d.length > 0);
      // Best-effort: a transient 404 / 500 on the autoallow fetch
      // shouldn't blank out the logins list. Any failure here means
      // the toggles default to "off" until the next refresh.
      try {
        await loadAutoallowFor(domains);
      } catch {
        setAutoallowMap({});
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("logins.error.loadFailed", { defaultValue: "load failed" }),
      );
      setLogins([]);
      setFailures([]);
    }
  }, [loadAutoallowFor, t]);

  const onToggleAutoallow = useCallback(
    async (domain: string, next: boolean) => {
      // Optimistic update — UI feels instant, falls back to the real
      // value on error.
      setAutoallowMap((prev) => ({ ...prev, [domain]: next }));
      const res = await fetch(
        `/api/secrets/logins/${encodeURIComponent(domain)}/autoallow`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ allowed: next }),
        },
      );
      if (!res.ok) {
        setError(`HTTP ${res.status} (autoallow update failed)`);
        setAutoallowMap((prev) => ({ ...prev, [domain]: !next }));
      }
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const onAdd = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!addDomain.trim() || !addUsername || !addPassword) return;
      setSubmitting(true);
      setError(null);
      const res = await fetch("/api/secrets/logins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domain: addDomain.trim(),
          username: addUsername,
          password: addPassword,
        }),
      });
      setSubmitting(false);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      setAddDomain("");
      setAddUsername("");
      setAddPassword("");
      setShowAdd(false);
      await load();
    },
    [addDomain, addUsername, addPassword, load],
  );

  const onDelete = useCallback(
    async (login: SavedLogin) => {
      if (login.source !== "in-house") return;
      const ok = window.confirm(
        t("logins.confirmDelete", {
          domain: login.domain ?? "—",
          username: login.username,
          defaultValue: "Delete saved login for {{domain}} ({{username}})?",
        }),
      );
      if (!ok) return;
      setError(null);
      const colon = login.identifier.indexOf(":");
      const domainPart = colon > 0 ? login.identifier.slice(0, colon) : "";
      const userPart = colon > 0 ? login.identifier.slice(colon + 1) : "";
      const path = `/api/secrets/logins/${encodeURIComponent(domainPart)}/${encodeURIComponent(userPart)}`;
      const res = await fetch(path, { method: "DELETE" });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      await load();
    },
    [load, t],
  );

  const filtered = (logins ?? []).filter((l) => {
    if (filter.trim().length === 0) return true;
    const needle = filter.trim().toLowerCase();
    return (
      l.title.toLowerCase().includes(needle) ||
      l.username.toLowerCase().includes(needle) ||
      (l.domain ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <section data-testid="saved-logins-panel" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-txt">
            {t("logins.title", { defaultValue: "Saved logins" })}
          </p>
          <p className="text-2xs text-muted">
            {t("logins.description", {
              defaultValue:
                "Browser autofill from local vault, 1Password, and Bitwarden.",
            })}
          </p>
        </div>
        <Button
          ref={addLoginRef}
          {...addLoginAgentProps}
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1 rounded-sm px-2"
          onClick={() => setShowAdd((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("logins.addLogin", { defaultValue: "Add login" })}
        </Button>
      </div>

      {error && (
        <div
          aria-live="polite"
          className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger"
        >
          {error}
        </div>
      )}

      {failures.length > 0 && (
        <div
          aria-live="polite"
          data-testid="saved-logins-failures"
          className="space-y-1"
        >
          {failures.map((f) => (
            <div
              key={f.source}
              className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-1.5 text-2xs text-warn"
            >
              {t("logins.sourceLoadFailed", {
                source: sourceLabel(f.source),
                message: f.message,
                defaultValue: "{{source}} failed to load: {{message}}",
              })}
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <form
          onSubmit={onAdd}
          className="space-y-2 rounded-sm border border-border/50 bg-card/30 p-2"
          data-testid="saved-logins-add-form"
        >
          <p className="text-2xs text-muted">
            {t("logins.addForm.help", {
              defaultValue:
                "Saved to local (encrypted) vault. To add to 1Password or Bitwarden, use that app directly.",
            })}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <Label className="text-2xs text-muted">
                {t("logins.addForm.domain", { defaultValue: "Domain" })}
              </Label>
              <Input
                ref={addDomainRef}
                {...addDomainAgentProps}
                value={addDomain}
                onChange={(e) => setAddDomain(e.target.value)}
                placeholder="github.com"
                className="h-8 text-xs"
                autoComplete="off"
                required
              />
            </div>
            <div>
              <Label className="text-2xs text-muted">
                {t("logins.addForm.username", {
                  defaultValue: "Username / email",
                })}
              </Label>
              <Input
                ref={addUsernameRef}
                {...addUsernameAgentProps}
                value={addUsername}
                onChange={(e) => setAddUsername(e.target.value)}
                placeholder="alice@example.com"
                className="h-8 text-xs"
                autoComplete="off"
                required
              />
            </div>
          </div>
          <div>
            <Label className="text-2xs text-muted">
              {t("logins.addForm.password", { defaultValue: "Password" })}
            </Label>
            <Input
              ref={addPasswordRef}
              {...addPasswordAgentProps}
              type="password"
              value={addPassword}
              onChange={(e) => setAddPassword(e.target.value)}
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
              {t("logins.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              ref={addSaveRef}
              {...addSaveAgentProps}
              type="submit"
              variant="default"
              size="sm"
              className="h-7 gap-1 rounded-sm px-3 text-xs"
              disabled={
                submitting || !addDomain.trim() || !addUsername || !addPassword
              }
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  {t("logins.saving", { defaultValue: "Saving…" })}
                </>
              ) : (
                t("logins.save", { defaultValue: "Save" })
              )}
            </Button>
          </div>
        </form>
      )}

      {logins !== null && logins.length > 0 && (
        <Input
          ref={filterRef}
          {...filterAgentProps}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("logins.filterPlaceholder", {
            defaultValue: "Filter by title, user, or domain",
          })}
          className="h-8 text-xs"
          autoComplete="off"
          data-testid="saved-logins-filter"
        />
      )}

      {logins === null ? (
        <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />{" "}
          {t("logins.loading", { defaultValue: "Loading…" })}
        </div>
      ) : logins.length === 0 ? (
        <div
          data-testid="saved-logins-empty"
          className="rounded-sm border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted"
        >
          {t("logins.empty", {
            defaultValue:
              "No saved logins yet. Add one here, or sign in to 1Password / Bitwarden on the Overview tab to surface their entries.",
          })}
        </div>
      ) : filtered.length === 0 ? (
        <div
          data-testid="saved-logins-no-match"
          className="rounded-sm border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted"
        >
          {t("logins.noMatch", {
            filter,
            defaultValue: 'No logins match "{{filter}}".',
          })}
        </div>
      ) : (
        <ul
          data-testid="saved-logins-list"
          className="space-y-1 rounded-sm border border-border/40 bg-card/30 p-1"
        >
          {filtered.map((login) => (
            <li
              key={`${login.source}:${login.identifier}`}
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-bg-muted/30"
            >
              <span
                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-2xs font-medium ${SOURCE_PILL_CLASS[login.source]}`}
              >
                {sourceLabel(login.source)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-txt">
                  {login.title}
                  {login.domain && login.domain !== login.title ? (
                    <span className="ml-1.5 text-muted">({login.domain})</span>
                  ) : null}
                </p>
                <p className="truncate text-2xs text-muted">
                  {login.username || "—"} · {relativeAge(login.updatedAt)}
                </p>
              </div>
              {login.domain ? (
                <AgentAutoallowToggle
                  domain={login.domain}
                  allowed={autoallowMap[login.domain] === true}
                  onChange={(next) =>
                    void onToggleAutoallow(login.domain ?? "", next)
                  }
                />
              ) : null}
              {login.source === "in-house" ? (
                <DeleteLoginButton
                  identifier={login.identifier}
                  target={login.domain ?? login.username}
                  onDelete={() => void onDelete(login)}
                />
              ) : (
                <ExternalRowAction login={login} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentAutoallowToggle({
  domain,
  allowed,
  onChange,
}: {
  domain: string;
  allowed: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `logins-autoallow-${domain}`,
    role: "toggle",
    label: `Agent autofill for ${domain}`,
    group: "logins",
    description: "Allow the agent to autofill this domain without prompting",
    status: allowed ? "active" : "inactive",
    onActivate: () => onChange(!allowed),
  });
  const label = allowed
    ? t("logins.autoallow.enabled", {
        domain,
        defaultValue:
          "Agent autofill enabled for {{domain}}. Click to disable.",
      })
    : t("logins.autoallow.disabled", {
        domain,
        defaultValue:
          "Allow the agent to autofill {{domain}} without prompting.",
      });
  return (
    <Button
      ref={ref}
      {...agentProps}
      variant="ghost"
      size="sm"
      className={`h-7 w-7 shrink-0 rounded-sm p-0 ${
        allowed ? "text-accent hover:text-accent" : "text-muted hover:text-txt"
      }`}
      aria-label={label}
      title={label}
      onClick={() => onChange(!allowed)}
      data-testid={`agent-autoallow-toggle-${domain}`}
      data-allowed={allowed ? "1" : "0"}
    >
      <Bot className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

function DeleteLoginButton({
  identifier,
  target,
  onDelete,
}: {
  identifier: string;
  target: string;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `logins-delete-${identifier}`,
    role: "button",
    label: `Delete saved login for ${target}`,
    group: "logins",
    onActivate: onDelete,
  });
  return (
    <Button
      ref={ref}
      {...agentProps}
      variant="ghost"
      size="sm"
      className="h-7 w-7 shrink-0 rounded-sm p-0 text-muted hover:text-danger"
      aria-label={t("logins.deleteLabel", {
        target,
        defaultValue: "Delete saved login for {{target}}",
      })}
      onClick={onDelete}
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

function ExternalRowAction({ login }: { login: SavedLogin }) {
  const { t } = useTranslation();
  const href =
    login.source === "1password"
      ? `https://my.1password.com/vaults/all/allitems/${encodeURIComponent(login.identifier)}`
      : "https://vault.bitwarden.com/";
  const viewLabel = t("logins.viewIn", {
    source: SOURCE_LABEL[login.source],
    defaultValue: "View in {{source}}",
  });
  const { ref, agentProps } = useAgentElement<HTMLAnchorElement>({
    id: `logins-view-external-${login.source}-${login.identifier}`,
    role: "link",
    label: viewLabel,
    group: "logins",
    description: `Open this login in ${SOURCE_LABEL[login.source]}`,
  });
  return (
    <a
      ref={ref}
      {...agentProps}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-sm border border-border/40 px-2 text-2xs text-muted hover:text-txt"
      aria-label={viewLabel}
      title={viewLabel}
    >
      <ExternalLink className="h-3 w-3" aria-hidden />
      {t("logins.view", { defaultValue: "View" })}
    </a>
  );
}
