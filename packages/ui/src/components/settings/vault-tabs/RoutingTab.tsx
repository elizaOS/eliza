/**
 * Routing tab — full-width per-context routing rules table plus the
 * "Default profile" setting. One source of truth: `GET/PUT
 * /api/secrets/routing`.
 *
 * Replaces the cramped per-row routing editor that used to live inside
 * `VaultInventoryPanel`. This tab shows every rule in the system and
 * supports wildcard key patterns (e.g. `OPENROUTER_*`).
 */

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { ArrowRight, Loader2, Plus, Trash2 } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
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
        setError(err instanceof Error ? err.message : "save failed");
      } finally {
        setSaving(false);
      }
    },
    [onConfigChange],
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
        `Delete routing rule for ${rule.keyPattern}?`,
      );
      if (!confirmed) return;
      const newRules = config.rules.filter((r) => r !== rule);
      await saveConfig({ ...config, rules: newRules });
    },
    [config, saveConfig],
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
      <section className="space-y-2 rounded-md border border-border/40 bg-card/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-txt">Default profile</p>
            <p className="text-2xs text-muted">
              Applied when no rule below matches a (key × scope) lookup.
              "default" is the fallback when this is empty.
            </p>
          </div>
          <select
            value={config.defaultProfile ?? "default"}
            onChange={(e) => void onDefaultProfileChange(e.target.value)}
            disabled={saving}
            data-testid="routing-default-profile"
            className="block h-8 w-40 rounded-md border border-border bg-bg px-2 text-xs text-txt"
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
            <p className="text-sm font-medium text-txt">Routing rules</p>
            <p className="text-2xs text-muted">
              Per-context overrides. Match keys exactly (e.g.
              <code className="mx-1 rounded bg-bg/40 px-1 font-mono">
                OPENROUTER_API_KEY
              </code>
              ) or use wildcards (e.g.
              <code className="mx-1 rounded bg-bg/40 px-1 font-mono">
                OPENROUTER_*
              </code>
              ).
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1 rounded-md px-2"
            onClick={() => setShowAdd((v) => !v)}
            disabled={saving}
            aria-label="Add routing rule"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add rule
          </Button>
        </div>

        {error && (
          <p
            className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger"
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
            placeholder="Filter rules by key, scope, or profile"
            className="h-8 text-xs"
            autoComplete="off"
            data-testid="routing-rules-filter"
          />
        )}

        {showAdd && (
          <form
            onSubmit={onAddRule}
            data-testid="routing-add-rule-form"
            className="space-y-2 rounded-md border border-border/50 bg-card/30 p-3"
          >
            <div>
              <Label className="text-2xs text-muted">Key pattern</Label>
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
                <Label className="text-2xs text-muted">Scope</Label>
                <select
                  value={scopeKind}
                  onChange={(e) =>
                    setScopeKind(e.target.value as RoutingScopeKind)
                  }
                  className="block h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-txt"
                >
                  <option value="agent">Agent</option>
                  <option value="app">App</option>
                </select>
              </div>
              <div>
                <Label className="text-2xs text-muted">
                  {scopeKind === "agent" ? "Agent" : "App"}
                </Label>
                {scopeKind === "agent" ? (
                  <select
                    value={scopeAgentId}
                    onChange={(e) => setScopeAgentId(e.target.value)}
                    className="block h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-txt"
                    required
                  >
                    <option value="">Select agent…</option>
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
                    className="block h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-txt"
                    required
                  >
                    <option value="">Select app…</option>
                    {apps.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.displayName ?? a.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <Label className="text-2xs text-muted">Profile</Label>
                <select
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                  className="block h-8 w-full rounded-md border border-border bg-bg px-2 text-xs text-txt"
                  required
                >
                  <option value="">Select profile…</option>
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
                className="h-7 rounded-md px-3 text-xs"
                onClick={() => setShowAdd(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="default"
                size="sm"
                className="h-7 rounded-md px-3 text-xs"
                disabled={saving || !keyPattern.trim() || !profileId}
              >
                {saving ? "Saving…" : "Save rule"}
              </Button>
            </div>
          </form>
        )}

        {config.rules.length === 0 ? (
          <div
            data-testid="routing-rules-empty"
            className="rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted"
          >
            No routing rules. The default profile applies for every caller.
          </div>
        ) : visibleRules.length === 0 ? (
          <div
            data-testid="routing-rules-no-match"
            className="rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted"
          >
            No rules match "{rulesFilter}".
          </div>
        ) : (
          <table
            data-testid="routing-rules-table"
            className="w-full table-fixed border-collapse rounded-md border border-border/40 bg-card/30 text-xs"
          >
            <thead>
              <tr className="text-left text-muted">
                <th className="px-2 py-1 font-medium">Key</th>
                <th className="px-2 py-1 font-medium">Scope</th>
                <th className="px-2 py-1 font-medium">Profile</th>
                <th className="w-16 px-2 py-1 font-medium text-right">
                  Actions
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
                          aria-label={`Open ${rule.keyPattern} in Secrets tab`}
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
                        className="h-6 w-6 rounded-md p-0 text-muted hover:text-danger"
                        onClick={() => void onDeleteRule(rule)}
                        aria-label={`Delete rule for ${rule.keyPattern}`}
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
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Saving…
          </div>
        )}
      </section>
    </div>
  );
}
