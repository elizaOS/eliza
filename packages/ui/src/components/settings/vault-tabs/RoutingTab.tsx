/**
 * Routing tab — full-width per-context routing rules table plus the
 * "Default profile" setting. One source of truth: `GET/PUT
 * /api/secrets/routing`. Supports wildcard key patterns (e.g.
 * `OPENROUTER_*`).
 */

import { ArrowRight, Loader2, Plus, Trash2 } from "lucide-react";
import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAgentElement } from "../../../agent-surface";
// All requests go through the shared client (never bare `fetch`) so they hit
// the configured apiBase and carry the injected auth token — a bare relative
// fetch targets the page origin unauthenticated, which breaks remote/token-
// authed runtimes (e.g. the Android local agent).
import { client } from "../../../api/client";
import { useTranslation } from "../../../state/TranslationContext.hooks";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
} from "../../ui/select";
import { SettingsSelectTrigger } from "../../ui/settings-controls";
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

  const { ref: defaultProfileRef, agentProps: defaultProfileAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "routing-default-profile",
      role: "select",
      label: "Default routing profile",
      group: "routing",
      description: "Profile applied when no rule matches",
      getValue: () => config.defaultProfile ?? "default",
      onFill: (v) => void onDefaultProfileChange(v),
    });
  const { ref: addRuleToggleRef, agentProps: addRuleToggleAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "routing-add-rule-toggle",
      role: "button",
      label: "Add routing rule",
      group: "routing",
      description: "Show the form to add a new routing rule",
    });
  const { ref: filterRef, agentProps: filterAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "routing-rules-filter",
      role: "text-input",
      label: "Filter routing rules",
      group: "routing",
      getValue: () => rulesFilter,
      onFill: (v) => setRulesFilter(v),
    });
  const { ref: keyPatternRef, agentProps: keyPatternAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "routing-key-pattern",
      role: "text-input",
      label: "Routing key pattern",
      group: "routing-add-rule",
      description: "Exact key or wildcard like OPENROUTER_*",
      getValue: () => keyPattern,
      onFill: (v) => setKeyPattern(v),
    });
  const { ref: scopeKindRef, agentProps: scopeKindAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "routing-scope-kind",
      role: "select",
      label: "Routing scope kind",
      group: "routing-add-rule",
      options: ["agent", "app"],
      getValue: () => scopeKind,
      onFill: (v) => setScopeKind(v as RoutingScopeKind),
    });
  const { ref: scopeAgentRef, agentProps: scopeAgentAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "routing-scope-agent",
      role: "select",
      label: "Routing scope agent",
      group: "routing-add-rule",
      options: agents.map((a) => a.id),
      getValue: () => scopeAgentId,
      onFill: (v) => setScopeAgentId(v),
    });
  const { ref: scopeAppRef, agentProps: scopeAppAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "routing-scope-app",
      role: "select",
      label: "Routing scope app",
      group: "routing-add-rule",
      options: apps.map((a) => a.name),
      getValue: () => scopeAppName,
      onFill: (v) => setScopeAppName(v),
    });
  const { ref: ruleProfileRef, agentProps: ruleProfileAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "routing-rule-profile",
      role: "select",
      label: "Routing rule profile",
      group: "routing-add-rule",
      getValue: () => profileId,
      onFill: (v) => setProfileId(v),
    });
  const { ref: ruleCancelRef, agentProps: ruleCancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "routing-rule-cancel",
      role: "button",
      label: "Cancel adding routing rule",
      group: "routing-add-rule",
      onActivate: () => setShowAdd(false),
    });
  const { ref: ruleSaveRef, agentProps: ruleSaveAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "routing-rule-save",
      role: "button",
      label: "Save routing rule",
      group: "routing-add-rule",
    });

  // Apply incoming focus from the Secrets tab "Routing rules for this
  // profile →" jump: pre-filter the list on the focused key.
  useEffect(() => {
    if (!focusKey) return;
    setRulesFilter(focusKey);
    onFocusApplied();
  }, [focusKey, onFocusApplied]);

  const allKeys = useMemo(() => entries.map((e) => e.key), [entries]);
  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) map.set(a.id, a.name);
    return map;
  }, [agents]);
  const appLabelByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of apps) {
      if (a.displayName) map.set(a.name, a.displayName);
    }
    return map;
  }, [apps]);
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
        const res = await client.rawRequest(
          "/api/secrets/routing",
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ config: next }),
          },
          { allowNonOk: true },
        );
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
                  'Applied when no rule matches. Falls back to "default".',
              })}
            </p>
          </div>
          <Select
            value={config.defaultProfile ?? "default"}
            onValueChange={(value) => void onDefaultProfileChange(value)}
            disabled={saving}
          >
            <SettingsSelectTrigger
              ref={defaultProfileRef}
              {...defaultProfileAgentProps}
              variant="filter"
              data-testid="routing-default-profile"
              className="w-40"
            >
              <SelectValue />
            </SettingsSelectTrigger>
            <SelectContent>
              {allProfileIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
              {t("routing.rules.description", {
                defaultValue:
                  "Per-context overrides. Match keys exactly (e.g. OPENROUTER_API_KEY) or use wildcards (e.g. OPENROUTER_*).",
              })}
            </p>
          </div>
          <Button
            ref={addRuleToggleRef}
            {...addRuleToggleAgentProps}
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
            ref={filterRef}
            {...filterAgentProps}
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
                ref={keyPatternRef}
                {...keyPatternAgentProps}
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
                <Select
                  value={scopeKind}
                  onValueChange={(value) =>
                    setScopeKind(value as RoutingScopeKind)
                  }
                >
                  <SettingsSelectTrigger
                    ref={scopeKindRef}
                    {...scopeKindAgentProps}
                    variant="touch"
                    className="w-full"
                  >
                    <SelectValue />
                  </SettingsSelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">
                      {t("routing.scope.agent", { defaultValue: "Agent" })}
                    </SelectItem>
                    <SelectItem value="app">
                      {t("routing.scope.app", { defaultValue: "App" })}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-2xs text-muted">
                  {scopeKind === "agent"
                    ? t("routing.scope.agent", { defaultValue: "Agent" })
                    : t("routing.scope.app", { defaultValue: "App" })}
                </Label>
                {scopeKind === "agent" ? (
                  <Select
                    value={scopeAgentId || undefined}
                    onValueChange={(value) => setScopeAgentId(value)}
                  >
                    <SettingsSelectTrigger
                      ref={scopeAgentRef}
                      {...scopeAgentAgentProps}
                      variant="touch"
                      className="w-full"
                    >
                      <SelectValue
                        placeholder={t("routing.selectAgent", {
                          defaultValue: "Select agent…",
                        })}
                      />
                    </SettingsSelectTrigger>
                    <SelectContent>
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select
                    value={scopeAppName || undefined}
                    onValueChange={(value) => setScopeAppName(value)}
                  >
                    <SettingsSelectTrigger
                      ref={scopeAppRef}
                      {...scopeAppAgentProps}
                      variant="touch"
                      className="w-full"
                    >
                      <SelectValue
                        placeholder={t("routing.selectApp", {
                          defaultValue: "Select app…",
                        })}
                      />
                    </SettingsSelectTrigger>
                    <SelectContent>
                      {apps.map((a) => (
                        <SelectItem key={a.name} value={a.name}>
                          {a.displayName ?? a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div>
                <Label className="text-2xs text-muted">
                  {t("routing.field.profile", { defaultValue: "Profile" })}
                </Label>
                <Select
                  value={profileId || undefined}
                  onValueChange={(value) => setProfileId(value)}
                >
                  <SettingsSelectTrigger
                    ref={ruleProfileRef}
                    {...ruleProfileAgentProps}
                    variant="touch"
                    className="w-full"
                  >
                    <SelectValue
                      placeholder={t("routing.selectProfile", {
                        defaultValue: "Select profile…",
                      })}
                    />
                  </SettingsSelectTrigger>
                  <SelectContent>
                    {profilesForNewRule.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                ref={ruleCancelRef}
                {...ruleCancelAgentProps}
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
                ref={ruleSaveRef}
                {...ruleSaveAgentProps}
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
                    ? (agentNameById.get(rule.scope.agentId ?? "") ?? targetId)
                    : rule.scope.kind === "app"
                      ? (appLabelByName.get(rule.scope.appName ?? "") ??
                        targetId)
                      : targetId;
                const ruleKey = `${rule.keyPattern}:${rule.scope.kind}:${targetId}:${rule.profileId}:${idx}`;
                const keyExists = allKeys.includes(rule.keyPattern);
                return (
                  <RoutingRuleRow
                    key={ruleKey}
                    ruleKey={ruleKey}
                    keyPattern={rule.keyPattern}
                    scopeKind={rule.scope.kind}
                    targetLabel={targetLabel}
                    profileId={rule.profileId}
                    keyExists={keyExists}
                    onOpenInSecrets={() =>
                      navigate({
                        tab: "secrets",
                        focusKey: rule.keyPattern,
                        focusProfileId: rule.profileId,
                      })
                    }
                    onDelete={() => void onDeleteRule(rule)}
                  />
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

interface RoutingRuleRowProps {
  ruleKey: string;
  keyPattern: string;
  scopeKind: string;
  targetLabel: string;
  profileId: string;
  keyExists: boolean;
  onOpenInSecrets: () => void;
  onDelete: () => void;
}

const RoutingRuleRow = memo(
  function RoutingRuleRow({
    ruleKey,
    keyPattern,
    scopeKind,
    targetLabel,
    profileId,
    keyExists,
    onOpenInSecrets,
    onDelete,
  }: RoutingRuleRowProps) {
    const { t } = useTranslation();
    const { ref: chipRef, agentProps: chipAgentProps } =
      useAgentElement<HTMLButtonElement>({
        id: `routing-key-chip-${ruleKey}`,
        role: "button",
        label: `Open ${keyPattern} in Secrets tab`,
        group: "routing-rules",
        description: "Jump to the Secrets tab pre-filtered to this key",
        onActivate: onOpenInSecrets,
      });
    const { ref: deleteRef, agentProps: deleteAgentProps } =
      useAgentElement<HTMLButtonElement>({
        id: `routing-rule-delete-${ruleKey}`,
        role: "button",
        label: `Delete routing rule for ${keyPattern}`,
        group: "routing-rules",
        onActivate: onDelete,
      });
    return (
      <tr
        data-testid={`routing-rule-row-${ruleKey}`}
        className="border-t border-border/30"
      >
        <td className="px-2 py-1.5 align-top">
          {keyExists ? (
            <button
              ref={chipRef}
              {...chipAgentProps}
              type="button"
              onClick={onOpenInSecrets}
              data-testid={`routing-key-chip-${ruleKey}`}
              className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-2xs font-medium text-accent hover:bg-accent/20"
              aria-label={t("routing.openInSecrets", {
                keyPattern,
                defaultValue: "Open {{keyPattern}} in Secrets tab",
              })}
            >
              {keyPattern}
              <ArrowRight className="h-3 w-3" aria-hidden />
            </button>
          ) : (
            <span className="font-mono text-2xs text-muted">{keyPattern}</span>
          )}
        </td>
        <td className="px-2 py-1.5 align-top">
          <span className="rounded-full border border-border/40 bg-bg/40 px-1.5 py-0.5 text-2xs text-muted">
            {scopeKind}
          </span>
          <span className="ml-1.5 text-2xs text-txt">{targetLabel}</span>
        </td>
        <td className="px-2 py-1.5 align-top">
          <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent">
            {profileId}
          </span>
        </td>
        <td className="px-2 py-1.5 align-top text-right">
          <Button
            ref={deleteRef}
            {...deleteAgentProps}
            variant="ghost"
            size="sm"
            className="h-6 w-6 rounded-sm p-0 text-muted hover:text-danger"
            onClick={onDelete}
            aria-label={t("routing.deleteRule", {
              keyPattern,
              defaultValue: "Delete rule for {{keyPattern}}",
            })}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </td>
      </tr>
    );
  },
  // Include handlers in the memo check so rows pick up changed navigation or
  // delete closures after their parent state changes.
  (prev, next) =>
    prev.ruleKey === next.ruleKey &&
    prev.keyPattern === next.keyPattern &&
    prev.scopeKind === next.scopeKind &&
    prev.targetLabel === next.targetLabel &&
    prev.profileId === next.profileId &&
    prev.keyExists === next.keyExists &&
    prev.onOpenInSecrets === next.onOpenInSecrets &&
    prev.onDelete === next.onDelete,
);
