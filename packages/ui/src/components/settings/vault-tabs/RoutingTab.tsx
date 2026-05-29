/**
 * Routing tab — full-width per-context routing rules table plus the
 * "Default profile" setting. One source of truth: `GET/PUT
 * /api/secrets/routing`.
 *
 * Replaces the cramped per-row routing editor that used to live inside
 * `VaultInventoryPanel`. This tab shows every rule in the system and
 * supports wildcard key patterns (e.g. `OPENROUTER_*`).
 */

import { ArrowRight, Loader2, Plus, Trash2 } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "../../../state/TranslationContext";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import type {
  AgentSummary,
  InstalledApp,
  RoutingConfig,
  RoutingRule,
  RoutingScope,
  RoutingScopeKind,
  VaultEntryMeta,
  VaultTabNavigate,
} from "./types";

export interface RoutingTabProps {
  config: RoutingConfig;
  agents: AgentSummary[];
  apps: InstalledApp[];
  entries: VaultEntryMeta[];
  onConfigChange: (next: RoutingConfig) => void;
  navigate: VaultTabNavigate;
  focusKey: string | null;
  onFocusApplied: () => void;
}

export function RoutingTab(props: RoutingTabProps) {
  const {
    config,
    agents,
    apps,
    entries,
    onConfigChange,
    navigate,
    focusKey,
    onFocusApplied,
  } = props;
  const { t } = useTranslation();

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [keyPattern, setKeyPattern] = useState("");
  const [scopeKind, setScopeKind] = useState<RoutingScopeKind>("agent");
  const [scopeAgentId, setScopeAgentId] = useState("");
  const [scopeAppName, setScopeAppName] = useState("");
  const [profileId, setProfileId] = useState("");
  const [rulesFilter, setRulesFilter] = useState("");

  // Apply incoming focus from the Secrets tab "Routing rules for this
  // profile →" jump: pre-filter the list on the focused key.
  useEffect(() => {
    if (!focusKey) return;
    setRulesFilter(focusKey);
    onFocusApplied();
  }, [focusKey, onFocusApplied]);

  const allKeys = useMemo(() => entries.map((e) => e.key), [entries]);
  const profilesByKey = useMemo(() => {
    const map = new Map<string, { id: string; label: string }[]>();
    for (const entry of entries) {
      map.set(entry.key, entry.profiles ?? []);
    }
    return map;
  }, [entries]);

  // Profiles available for the rule being added: when the new pattern
  // matches an exact key, surface that key's profiles. Wildcards fall
  // back to the union across all keys.
  const profilesForNewRule = useMemo(() => {
    if (!keyPattern) return [];
    const exact = profilesByKey.get(keyPattern);
    if (exact && exact.length > 0) return exact;
    const ids = new Set<string>();
    const list: { id: string; label: string }[] = [];
    for (const entry of entries) {
      for (const p of entry.profiles ?? []) {
        if (ids.has(p.id)) continue;
        ids.add(p.id);
        list.push(p);
      }
    }
    return list;
  }, [keyPattern, profilesByKey, entries]);

  const allProfileIds = useMemo(() => {
    const ids = new Set<string>(["default"]);
    for (const entry of entries) {
      for (const p of entry.profiles ?? []) ids.add(p.id);
    }
    return Array.from(ids);
  }, [entries]);

  const saveConfig = useCallback(
    async (next: RoutingConfig) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/secrets/routing", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: next }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { config: RoutingConfig };
        onConfigChange(body.config);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("routing.error.saveFailed", { defaultValue: "save failed" }),
        );
      } finally {
        setSaving(false);
      }
    },
    [onConfigChange, t],
  );

  const onAddRule = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!keyPattern.trim() || !profileId) return;
      let scope: RoutingScope;
      if (scopeKind === "agent") {
        if (!scopeAgentId) return;
        scope = { kind: "agent", agentId: scopeAgentId };
      } else if (scopeKind === "app") {
        if (!scopeAppName) return;
        scope = { kind: "app", appName: scopeAppName };
      } else {
        return;
      }
      const newRules = [
        ...config.rules,
        { keyPattern: keyPattern.trim(), scope, profileId },
      ];
      await saveConfig({ ...config, rules: newRules });
      setShowAdd(false);
      setKeyPattern("");
      setScopeAgentId("");
      setScopeAppName("");
      setProfileId("");
    },
    [
      config,
      keyPattern,
      profileId,
      saveConfig,
      scopeAgentId,
      scopeAppName,
      scopeKind,
    ],
  );

  const onDeleteRule = useCallback(
    async (rule: RoutingRule) => {
      const confirmed = window.confirm(
        t("routing.confirmDelete", {
          keyPattern: rule.keyPattern,
          defaultValue: "Delete routing rule for {{keyPattern}}?",
        }),
      );
      if (!confirmed) return;
      const newRules = config.rules.filter((r) => r !== rule);
      await saveConfig({ ...config, rules: newRules });
    },
    [config, saveConfig, t],
  );

  const onDefaultProfileChange = useCallback(
    async (next: string) => {
      const trimmed = next.trim();
      await saveConfig({
        ...config,
        defaultProfile: trimmed.length > 0 ? trimmed : undefined,
      });
    },
    [config, saveConfig],
  );

  const visibleRules = useMemo(() => {
    if (!rulesFilter.trim()) return config.rules;
    const needle = rulesFilter.trim().toLowerCase();
    return config.rules.filter((r) => {
      if (r.keyPattern.toLowerCase().includes(needle)) return true;
      const targetId =
        r.scope.agentId ?? r.scope.appName ?? r.scope.skillId ?? "";
      if (targetId.toLowerCase().includes(needle)) return true;
      return r.profileId.toLowerCase().includes(needle);
    });
  }, [config.rules, rulesFilter]);

  return (
    <div data-testid="routing-tab" className="space-y-4">
      {/* Default profile */}
      <section className="space-y-2 rounded-sm border border-border/40 bg-card/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-txt">
              {t("routing.defaultProfile.title", {
                defaultValue: "Default profile",
              })}
            </p>
            <p className="text-2xs text-muted">
              {t("routing.defaultProfile.description", {
                defaultValue:
                  'Applied when no rule below matches a (key × scope) lookup. "default" is the fallback when this is empty.',
              })}
            </p>
          </div>
          <select
            value={config.defaultProfile ?? "default"}
            onChange={(e) => void onDefaultProfileChange(e.target.value)}
            disabled={saving}
            data-testid="routing-default-profile"
            className="block h-8 w-40 rounded-sm border border-border bg-bg px-2 text-xs text-txt"
          >
            {allProfileIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Rules table */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-txt">
              {t("routing.rules.title", { defaultValue: "Routing rules" })}
            </p>
            <p className="text-2xs text-muted">
              {t("routing.rules.descriptionPrefix", {
                defaultValue: "Per-context overrides. Match keys exactly (e.g.",
              })}
              <code className="mx-1 rounded-sm bg-bg/40 px-1 font-mono">
                OPENROUTER_API_KEY
              </code>
              {t("routing.rules.descriptionMid", {
                defaultValue: ") or use wildcards (e.g.",
              })}
              <code className="mx-1 rounded-sm bg-bg/40 px-1 font-mono">
                OPENROUTER_*
              </code>
              {t("routing.rules.descriptionSuffix", { defaultValue: ")." })}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1 rounded-sm px-2"
            onClick={() => setShowAdd((v) => !v)}
            disabled={saving}
            aria-label={t("routing.addRule", {
              defaultValue: "Add routing rule",
            })}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />{" "}
            {t("routing.addRuleShort", { defaultValue: "Add rule" })}
          </Button>
        </div>

        {error && (
          <p
            className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger"
            aria-live="polite"
            data-testid="routing-tab-error"
          >
            {error}
          </p>
        )}

        {config.rules.length > 0 && (
          <Input
            value={rulesFilter}
            onChange={(e) => setRulesFilter(e.target.value)}
            placeholder={t("routing.filterPlaceholder", {
              defaultValue: "Filter rules by key, scope, or profile",
            })}
            className="h-8 text-xs"
            autoComplete="off"
            data-testid="routing-rules-filter"
          />
        )}

        {showAdd && (
          <form
            onSubmit={onAddRule}
            data-testid="routing-add-rule-form"
            className="space-y-2 rounded-sm border border-border/50 bg-card/30 p-3"
          >
            <div>
              <Label className="text-2xs text-muted">
                {t("routing.field.keyPattern", {
                  defaultValue: "Key pattern",
                })}
              </Label>
              <Input
                value={keyPattern}
                onChange={(e) => setKeyPattern(e.target.value)}
                placeholder="OPENROUTER_API_KEY or OPENROUTER_*"
                className="h-8 font-mono text-xs"
                autoComplete="off"
                list="routing-key-suggestions"
                required
              />
              <datalist id="routing-key-suggestions">
                {allKeys.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <Label className="text-2xs text-muted">
                  {t("routing.field.scope", { defaultValue: "Scope" })}
                </Label>
                <select
                  value={scopeKind}
                  onChange={(e) =>
                    setScopeKind(e.target.value as RoutingScopeKind)
                  }
                  className="block h-8 w-full rounded-sm border border-border bg-bg px-2 text-xs text-txt"
                >
                  <option value="agent">
                    {t("routing.scope.agent", { defaultValue: "Agent" })}
                  </option>
                  <option value="app">
                    {t("routing.scope.app", { defaultValue: "App" })}
                  </option>
                </select>
              </div>
              <div>
                <Label className="text-2xs text-muted">
                  {scopeKind === "agent"
                    ? t("routing.scope.agent", { defaultValue: "Agent" })
                    : t("routing.scope.app", { defaultValue: "App" })}
                </Label>
                {scopeKind === "agent" ? (
                  <select
                    value={scopeAgentId}
                    onChange={(e) => setScopeAgentId(e.target.value)}
                    className="block h-8 w-full rounded-sm border border-border bg-bg px-2 text-xs text-txt"
                    required
                  >
                    <option value="">
                      {t("routing.selectAgent", {
                        defaultValue: "Select agent…",
                      })}
                    </option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={scopeAppName}
                    onChange={(e) => setScopeAppName(e.target.value)}
                    className="block h-8 w-full rounded-sm border border-border bg-bg px-2 text-xs text-txt"
                    required
                  >
                    <option value="">
                      {t("routing.selectApp", { defaultValue: "Select app…" })}
                    </option>
                    {apps.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.displayName ?? a.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <Label className="text-2xs text-muted">
                  {t("routing.field.profile", { defaultValue: "Profile" })}
                </Label>
                <select
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                  className="block h-8 w-full rounded-sm border border-border bg-bg px-2 text-xs text-txt"
                  required
                >
                  <option value="">
                    {t("routing.selectProfile", {
                      defaultValue: "Select profile…",
                    })}
                  </option>
                  {profilesForNewRule.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 rounded-sm px-3 text-xs"
                onClick={() => setShowAdd(false)}
                disabled={saving}
              >
                {t("routing.cancel", { defaultValue: "Cancel" })}
              </Button>
              <Button
                type="submit"
                variant="default"
                size="sm"
                className="h-7 rounded-sm px-3 text-xs"
                disabled={saving || !keyPattern.trim() || !profileId}
              >
                {saving
                  ? t("routing.saving", { defaultValue: "Saving…" })
                  : t("routing.saveRule", { defaultValue: "Save rule" })}
              </Button>
            </div>
          </form>
        )}

        {config.rules.length === 0 ? (
          <div
            data-testid="routing-rules-empty"
            className="rounded-sm border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted"
          >
            {t("routing.empty", {
              defaultValue:
                "No routing rules. The default profile applies for every caller.",
            })}
          </div>
        ) : visibleRules.length === 0 ? (
          <div
            data-testid="routing-rules-no-match"
            className="rounded-sm border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted"
          >
            {t("routing.noMatch", {
              filter: rulesFilter,
              defaultValue: 'No rules match "{{filter}}".',
            })}
          </div>
        ) : (
          <table
            data-testid="routing-rules-table"
            className="w-full table-fixed border-collapse rounded-sm border border-border/40 bg-card/30 text-xs"
          >
            <thead>
              <tr className="text-left text-muted">
                <th className="px-2 py-1 font-medium">
                  {t("routing.table.key", { defaultValue: "Key" })}
                </th>
                <th className="px-2 py-1 font-medium">
                  {t("routing.table.scope", { defaultValue: "Scope" })}
                </th>
                <th className="px-2 py-1 font-medium">
                  {t("routing.table.profile", { defaultValue: "Profile" })}
                </th>
                <th className="w-16 px-2 py-1 font-medium text-right">
                  {t("routing.table.actions", { defaultValue: "Actions" })}
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRules.map((rule, idx) => {
                const targetId =
                  rule.scope.agentId ??
                  rule.scope.appName ??
                  rule.scope.skillId ??
                  "—";
                const targetLabel =
                  rule.scope.kind === "agent"
                    ? (agents.find((a) => a.id === rule.scope.agentId)?.name ??
                      targetId)
                    : rule.scope.kind === "app"
                      ? (apps.find((a) => a.name === rule.scope.appName)
                          ?.displayName ?? targetId)
                      : targetId;
                const ruleKey = `${rule.keyPattern}:${rule.scope.kind}:${targetId}:${rule.profileId}:${idx}`;
                const keyExists = allKeys.includes(rule.keyPattern);
                return (
                  <tr
                    key={ruleKey}
                    data-testid={`routing-rule-row-${ruleKey}`}
                    className="border-t border-border/30"
                  >
                    <td className="px-2 py-1.5 align-top">
                      {keyExists ? (
                        <button
                          type="button"
                          onClick={() =>
                            navigate({
                              tab: "secrets",
                              focusKey: rule.keyPattern,
                              focusProfileId: rule.profileId,
                            })
                          }
                          data-testid={`routing-key-chip-${ruleKey}`}
                          className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-2xs font-medium text-accent hover:bg-accent/20"
                          aria-label={t("routing.openInSecrets", {
                            keyPattern: rule.keyPattern,
                            defaultValue: "Open {{keyPattern}} in Secrets tab",
                          })}
                        >
                          {rule.keyPattern}
                          <ArrowRight className="h-3 w-3" aria-hidden />
                        </button>
                      ) : (
                        <span className="font-mono text-2xs text-muted">
                          {rule.keyPattern}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 align-top">
                      <span className="rounded-full border border-border/40 bg-bg/40 px-1.5 py-0.5 text-2xs text-muted">
                        {rule.scope.kind}
                      </span>
                      <span className="ml-1.5 text-2xs text-txt">
                        {targetLabel}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 align-top">
                      <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent">
                        {rule.profileId}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 align-top text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 rounded-sm p-0 text-muted hover:text-danger"
                        onClick={() => void onDeleteRule(rule)}
                        aria-label={t("routing.deleteRule", {
                          keyPattern: rule.keyPattern,
                          defaultValue: "Delete rule for {{keyPattern}}",
                        })}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {saving && (
          <div className="flex items-center gap-2 px-1 text-2xs text-muted">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />{" "}
            {t("routing.saving", { defaultValue: "Saving…" })}
          </div>
        )}
      </section>
    </div>
  );
}
