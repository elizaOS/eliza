// odysseus Settings panel (static/js/settings.js + search.js, settings-modal
// rules in style.css). Tabbed surface — General / Web Search / Models / Persona
// / Appearance — pinned to the TOP of the chat area (Issue #208: a centered
// window jumps up and down between tabs whose content height differs, so we use
// a fixed-height panel anchored to flex-start so the rail and window never
// shift between tab switches).
//
// elizaMapping — real eliza wiring where the @elizaos/ui `client` exposes it,
// honest local state where it does NOT:
//   • General — MCP servers via client.getMcpStatus() (read-only status).
//   • Models  — installed plugins via client.getPlugins(); model-category
//     plugins are surfaced as the "model chain" stand-in (eliza owns the model
//     map; there is no per-endpoint model picker to wire here, so we render the
//     real plugin list rather than fabricate odysseus's endpoint editor).
//   • Persona (odysseus +56 renamed "Character" → "Persona") — real
//     client.getCharacter() / updateCharacter(CharacterData): name, bio, system
//     prompt, adjectives, topics. Saved through the live agent config.
//   • Web Search — odysseus's search-provider + custom-result-count + advanced
//     serve controls are odysseus's /api/auth/settings surface, which eliza's
//     client does NOT expose. Rather than invent a client method (tsgo would
//     fail) or fake a backend, these persist locally via readPref/writePref
//     under PREF_KEYS.searchSettings, with an honest note that they're a
//     local preference until an eliza search-config endpoint exists.
//   • Appearance — mirrors the live theme/font/density prefs (PREF_KEYS) that
//     OdysseusShell owns. Read-only here (the shell is the single writer) so the
//     two surfaces never desync; deep-links the user to the shell's theme rail.

import type { CharacterData, McpServerStatus, PluginInfo } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { PREF_KEYS, readPref, writePref } from "./util/storage";

// localStorage key for the locally-persisted web-search preference. The web
// search provider / result-count / key fields are odysseus's /api/auth/settings
// surface, which eliza's client does NOT expose — so this view owns its own
// (non-shared) pref rather than adding to the shared PREF_KEYS table, matching
// the CompareView precedent (COMPARE_VOTES_KEY). If a future eliza search-config
// endpoint lands, promote this to PREF_KEYS.searchSettings (see integrationNotes).
const SEARCH_SETTINGS_KEY = "search-settings";

type SettingsTab =
  | "general"
  | "web-search"
  | "models"
  | "persona"
  | "appearance";

const TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "web-search", label: "Web Search" },
  { id: "models", label: "Models" },
  { id: "persona", label: "Persona" },
  { id: "appearance", label: "Appearance" },
];

// ── Web-search providers (search.js _labels + settings.js _searchProviderHints
// / _searchNeedsKey / _searchKeyFields), 1:1 from upstream. ──
type SearchProvider =
  | "searxng"
  | "duckduckgo"
  | "brave"
  | "google_pse"
  | "tavily"
  | "serper"
  | "disabled";

interface SearchProviderMeta {
  id: SearchProvider;
  label: string;
  hint: string;
  needsKey: boolean;
}

const SEARCH_PROVIDERS: readonly SearchProviderMeta[] = [
  {
    id: "searxng",
    label: "SearXNG",
    hint: "Self-hosted SearXNG instance. Leave URL empty to use the SEARXNG_INSTANCE env var.",
    needsKey: false,
  },
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    hint: "Free search — no API key required. Works out of the box.",
    needsKey: false,
  },
  {
    id: "brave",
    label: "Brave Search",
    hint: "Get your API key from brave.com/search/api",
    needsKey: true,
  },
  {
    id: "google_pse",
    label: "Google PSE",
    hint: "Requires a Google API key and a Programmable Search Engine ID (CX). Create one at programmablesearchengine.google.com",
    needsKey: true,
  },
  {
    id: "tavily",
    label: "Tavily",
    hint: "AI-optimized search. 1,000 free credits/month at tavily.com",
    needsKey: true,
  },
  {
    id: "serper",
    label: "Serper",
    hint: "Google results via API. 2,500 free queries at serper.dev",
    needsKey: true,
  },
  {
    id: "disabled",
    label: "Disabled",
    hint: "Web search and deep research tools will be unavailable.",
    needsKey: false,
  },
];

// Result-count presets (settings.js updateCountDisplay), plus "custom".
const RESULT_COUNT_PRESETS: readonly number[] = [3, 5, 10, 20];

function isPresetCount(n: number): boolean {
  return RESULT_COUNT_PRESETS.includes(n);
}

// Locally-persisted web-search preference (odysseus search_* settings shape,
// trimmed to what this surface edits). Persisted via PREF_KEYS.searchSettings
// until eliza exposes a search-config client method.
interface SearchSettings {
  provider: SearchProvider;
  resultCount: number;
  searxngUrl: string;
  apiKey: string;
  googlePseCx: string;
}

const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  provider: "searxng",
  resultCount: 5,
  searxngUrl: "",
  apiKey: "",
  googlePseCx: "",
};

function providerMeta(id: SearchProvider): SearchProviderMeta {
  const found = SEARCH_PROVIDERS.find((p) => p.id === id);
  return found ?? SEARCH_PROVIDERS[0];
}

// Narrow the <select>'s string value to a known SearchProvider without a cast:
// look it up in the provider table (the only source of <option> values), so an
// unknown value falls back to the first provider instead of asserting a type.
function toSearchProvider(value: string): SearchProvider {
  const found = SEARCH_PROVIDERS.find((p) => p.id === value);
  return found ? found.id : SEARCH_PROVIDERS[0].id;
}

// CharacterData.bio is string | string[]; normalize to an editable string
// (join the array with blank lines, the same way odysseus's persona editor
// presents a multi-line bio).
function bioToText(bio: CharacterData["bio"]): string {
  if (Array.isArray(bio)) return bio.join("\n\n");
  return bio ?? "";
}

// adjectives/topics edit as comma-separated text; split + trim on save.
function listToText(list: string[] | undefined): string {
  return (list ?? []).join(", ");
}

function textToList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function SettingsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const [tab, setTab] = useState<SettingsTab>("general");

  // General — MCP servers (real status).
  const [servers, setServers] = useState<McpServerStatus[]>([]);

  // Models — installed plugins (real list).
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);

  // Web search — local preference (no eliza backend).
  const [search, setSearch] = useState<SearchSettings>(DEFAULT_SEARCH_SETTINGS);
  const [countMode, setCountMode] = useState<"preset" | "custom">("preset");

  // Persona — real character config.
  const [agentName, setAgentName] = useState("");
  const [personaName, setPersonaName] = useState("");
  const [personaBio, setPersonaBio] = useState("");
  const [personaSystem, setPersonaSystem] = useState("");
  const [personaAdjectives, setPersonaAdjectives] = useState("");
  const [personaTopics, setPersonaTopics] = useState("");
  const [personaLoaded, setPersonaLoaded] = useState(false);
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaMsg, setPersonaMsg] = useState("");

  // Appearance — read-only mirror of the live shell prefs.
  const [themeMode, setThemeMode] = useState("dark");
  const [font, setFont] = useState("mono");
  const [density, setDensity] = useState("comfortable");

  useEffect(() => {
    if (!open) return;
    void client
      .getMcpStatus()
      .then((r) => setServers(r.servers))
      .catch(() => setServers([]));
    void client
      .getPlugins()
      .then((r) => setPlugins(r.plugins))
      .catch(() => setPlugins([]));

    const stored = readPref<SearchSettings>(
      SEARCH_SETTINGS_KEY,
      DEFAULT_SEARCH_SETTINGS,
    );
    setSearch(stored);
    setCountMode(isPresetCount(stored.resultCount) ? "preset" : "custom");

    setPersonaLoaded(false);
    void client
      .getCharacter()
      .then((r) => {
        setAgentName(r.agentName);
        setPersonaName(r.character.name ?? "");
        setPersonaBio(bioToText(r.character.bio));
        setPersonaSystem(r.character.system ?? "");
        setPersonaAdjectives(listToText(r.character.adjectives));
        setPersonaTopics(listToText(r.character.topics));
        setPersonaLoaded(true);
      })
      .catch(() => setPersonaLoaded(true));

    setThemeMode(readPref<string>(PREF_KEYS.themeMode, "dark"));
    setFont(readPref<string>(PREF_KEYS.font, "mono"));
    setDensity(readPref<string>(PREF_KEYS.density, "comfortable"));
  }, [open]);

  if (!open) return null;

  const persistSearch = (next: SearchSettings) => {
    setSearch(next);
    writePref(SEARCH_SETTINGS_KEY, next);
  };

  const activeProvider = providerMeta(search.provider);
  const searchStatus =
    search.provider === "disabled"
      ? "Search disabled"
      : `${activeProvider.label} · ${search.resultCount} results${
          activeProvider.needsKey
            ? search.apiKey.trim()
              ? " · key set"
              : " · no key"
            : ""
        }`;

  const savePersona = () => {
    setPersonaSaving(true);
    setPersonaMsg("");
    const payload: CharacterData = {
      name: personaName.trim(),
      bio: personaBio,
      system: personaSystem,
      adjectives: textToList(personaAdjectives),
      topics: textToList(personaTopics),
    };
    void client
      .updateCharacter(payload)
      .then((r) => {
        setAgentName(r.agentName);
        setPersonaMsg("Saved");
        setPersonaSaving(false);
      })
      .catch(() => {
        setPersonaMsg("Failed to save");
        setPersonaSaving(false);
      });
  };

  const modelPlugins = plugins.filter((p) => p.category === "ai-provider");
  const otherPlugins = plugins.filter((p) => p.category !== "ai-provider");

  return (
    <div
      className="od-search-overlay od-settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-settings-panel">
        {/* ── Header (settings-modal header) ── */}
        <div className="od-settings-header">
          <span className="od-settings-header-title">Settings</span>
          <span className="od-settings-header-spacer" />
          <button
            type="button"
            className="od-settings-close"
            aria-label="Close settings"
            title="Close settings"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* ── Body: left tab rail + anchored panels ── */}
        <div className="od-settings-body">
          <div
            className="od-settings-rail"
            role="tablist"
            aria-label="Settings sections"
          >
            <div className="od-settings-rail-label">Settings</div>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`od-settings-rail-item${tab === t.id ? " active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="od-settings-panels">
            {tab === "general" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <div className="od-settings-card-title">MCP Servers</div>
                  {servers.length === 0 ? (
                    <div className="od-settings-empty">
                      No MCP servers configured.
                    </div>
                  ) : (
                    servers.map((s) => (
                      <div className="od-skill-item" key={s.name}>
                        <div className="od-skill-info">
                          <div className="od-skill-name">{s.name}</div>
                          {s.error ? (
                            <div className="od-skill-desc">{s.error}</div>
                          ) : null}
                        </div>
                        <span
                          className={`od-skill-toggle${s.connected ? " on" : ""}`}
                        >
                          {s.connected ? "Up" : "Down"}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                <div className="od-settings-card">
                  <div className="od-settings-card-title">Agent</div>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Active agent</span>
                    <span className="od-settings-value">
                      {agentName || "—"}
                    </span>
                  </div>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Plugins loaded</span>
                    <span className="od-settings-value">{plugins.length}</span>
                  </div>
                </div>
              </div>
            ) : null}

            {tab === "web-search" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <div className="od-settings-card-title">Web Search</div>
                  <div className="od-settings-field">
                    <label
                      className="od-settings-flabel"
                      htmlFor="od-set-search-provider"
                    >
                      Provider
                    </label>
                    <select
                      id="od-set-search-provider"
                      className="od-settings-select"
                      value={search.provider}
                      onChange={(e) =>
                        persistSearch({
                          ...search,
                          provider: toSearchProvider(e.target.value),
                        })
                      }
                    >
                      {SEARCH_PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <div className="od-settings-hint">
                      {activeProvider.hint}
                    </div>
                  </div>

                  {search.provider !== "disabled" ? (
                    <div className="od-settings-field">
                      <label
                        className="od-settings-flabel"
                        htmlFor="od-set-search-count"
                      >
                        Result count
                      </label>
                      <select
                        id="od-set-search-count"
                        className="od-settings-select"
                        value={
                          countMode === "custom"
                            ? "custom"
                            : String(search.resultCount)
                        }
                        onChange={(e) => {
                          if (e.target.value === "custom") {
                            setCountMode("custom");
                            return;
                          }
                          setCountMode("preset");
                          persistSearch({
                            ...search,
                            resultCount: Number.parseInt(e.target.value, 10),
                          });
                        }}
                      >
                        {RESULT_COUNT_PRESETS.map((n) => (
                          <option key={n} value={String(n)}>
                            {n} results
                          </option>
                        ))}
                        <option value="custom">Custom…</option>
                      </select>
                      {countMode === "custom" ? (
                        <input
                          className="od-settings-input"
                          type="number"
                          min={1}
                          max={100}
                          value={search.resultCount}
                          aria-label="Custom result count"
                          onChange={(e) => {
                            const raw = Number.parseInt(e.target.value, 10);
                            const clamped = Number.isFinite(raw)
                              ? Math.max(1, Math.min(100, raw))
                              : search.resultCount;
                            persistSearch({ ...search, resultCount: clamped });
                          }}
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {search.provider === "searxng" ? (
                    <div className="od-settings-field">
                      <label
                        className="od-settings-flabel"
                        htmlFor="od-set-search-url"
                      >
                        SearXNG URL
                      </label>
                      <input
                        id="od-set-search-url"
                        className="od-settings-input"
                        type="text"
                        placeholder="https://searxng.example.com"
                        value={search.searxngUrl}
                        onChange={(e) =>
                          persistSearch({
                            ...search,
                            searxngUrl: e.target.value,
                          })
                        }
                      />
                    </div>
                  ) : null}

                  {activeProvider.needsKey ? (
                    <div className="od-settings-field">
                      <label
                        className="od-settings-flabel"
                        htmlFor="od-set-search-key"
                      >
                        API key
                      </label>
                      <input
                        id="od-set-search-key"
                        className="od-settings-input"
                        type="password"
                        placeholder={`${activeProvider.label} API key`}
                        value={search.apiKey}
                        onChange={(e) =>
                          persistSearch({ ...search, apiKey: e.target.value })
                        }
                      />
                    </div>
                  ) : null}

                  {search.provider === "google_pse" ? (
                    <div className="od-settings-field">
                      <label
                        className="od-settings-flabel"
                        htmlFor="od-set-search-cx"
                      >
                        Search Engine ID (CX)
                      </label>
                      <input
                        id="od-set-search-cx"
                        className="od-settings-input"
                        type="text"
                        placeholder="Programmable Search Engine ID"
                        value={search.googlePseCx}
                        onChange={(e) =>
                          persistSearch({
                            ...search,
                            googlePseCx: e.target.value,
                          })
                        }
                      />
                    </div>
                  ) : null}

                  <div
                    className={`od-settings-status${
                      search.provider === "disabled" ||
                      (activeProvider.needsKey && !search.apiKey.trim())
                        ? " warn"
                        : ""
                    }`}
                  >
                    {searchStatus}
                  </div>
                  <div className="od-settings-note">
                    Stored as a local browser preference — eliza does not yet
                    expose a search-config endpoint to persist this server-side.
                  </div>
                </div>
              </div>
            ) : null}

            {tab === "models" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <div className="od-settings-card-title">Model Providers</div>
                  {modelPlugins.length === 0 ? (
                    <div className="od-settings-empty">
                      No model provider plugins installed.
                    </div>
                  ) : (
                    modelPlugins.map((p) => (
                      <div className="od-skill-item" key={p.id}>
                        <div className="od-skill-info">
                          <div className="od-skill-name">{p.name}</div>
                          <div className="od-skill-desc">
                            {p.configured ? "configured" : "not configured"}
                          </div>
                        </div>
                        <span
                          className={`od-skill-toggle${p.enabled ? " on" : ""}`}
                        >
                          {p.enabled ? "On" : "Off"}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                <div className="od-settings-card">
                  <div className="od-settings-card-title">
                    Other Plugins ({otherPlugins.length})
                  </div>
                  {otherPlugins.length === 0 ? (
                    <div className="od-settings-empty">No other plugins.</div>
                  ) : (
                    otherPlugins.map((p) => (
                      <div className="od-skill-item" key={p.id}>
                        <div className="od-skill-info">
                          <div className="od-skill-name">{p.name}</div>
                          <div className="od-skill-desc">
                            {p.category}
                            {p.configured ? "" : " · not configured"}
                          </div>
                        </div>
                        <span
                          className={`od-skill-toggle${p.enabled ? " on" : ""}`}
                        >
                          {p.enabled ? "On" : "Off"}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            {tab === "persona" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <div className="od-settings-card-title">Persona</div>
                  {!personaLoaded ? (
                    <div className="od-settings-empty">Loading persona…</div>
                  ) : (
                    <>
                      <div className="od-settings-field">
                        <label
                          className="od-settings-flabel"
                          htmlFor="od-set-persona-name"
                        >
                          Name
                        </label>
                        <input
                          id="od-set-persona-name"
                          className="od-settings-input"
                          type="text"
                          value={personaName}
                          onChange={(e) => setPersonaName(e.target.value)}
                        />
                      </div>
                      <div className="od-settings-field">
                        <label
                          className="od-settings-flabel"
                          htmlFor="od-set-persona-bio"
                        >
                          Bio
                        </label>
                        <textarea
                          id="od-set-persona-bio"
                          className="od-settings-textarea"
                          rows={3}
                          value={personaBio}
                          onChange={(e) => setPersonaBio(e.target.value)}
                        />
                      </div>
                      <div className="od-settings-field">
                        <label
                          className="od-settings-flabel"
                          htmlFor="od-set-persona-system"
                        >
                          System prompt
                        </label>
                        <textarea
                          id="od-set-persona-system"
                          className="od-settings-textarea"
                          rows={4}
                          value={personaSystem}
                          onChange={(e) => setPersonaSystem(e.target.value)}
                        />
                      </div>
                      <div className="od-settings-field">
                        <label
                          className="od-settings-flabel"
                          htmlFor="od-set-persona-adjectives"
                        >
                          Adjectives
                        </label>
                        <input
                          id="od-set-persona-adjectives"
                          className="od-settings-input"
                          type="text"
                          placeholder="curious, precise, dry"
                          value={personaAdjectives}
                          onChange={(e) => setPersonaAdjectives(e.target.value)}
                        />
                        <div className="od-settings-hint">Comma-separated.</div>
                      </div>
                      <div className="od-settings-field">
                        <label
                          className="od-settings-flabel"
                          htmlFor="od-set-persona-topics"
                        >
                          Topics
                        </label>
                        <input
                          id="od-set-persona-topics"
                          className="od-settings-input"
                          type="text"
                          placeholder="systems, ml, gardening"
                          value={personaTopics}
                          onChange={(e) => setPersonaTopics(e.target.value)}
                        />
                        <div className="od-settings-hint">Comma-separated.</div>
                      </div>
                      <div className="od-settings-actions">
                        <button
                          type="button"
                          className="od-settings-save"
                          disabled={personaSaving}
                          onClick={savePersona}
                        >
                          {personaSaving ? "Saving…" : "Save persona"}
                        </button>
                        {personaMsg ? (
                          <span
                            className={`od-settings-status${
                              personaMsg === "Failed to save" ? " warn" : ""
                            }`}
                          >
                            {personaMsg}
                          </span>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : null}

            {tab === "appearance" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <div className="od-settings-card-title">Appearance</div>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Theme</span>
                    <span className="od-settings-value">{themeMode}</span>
                  </div>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Font</span>
                    <span className="od-settings-value">{font}</span>
                  </div>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Density</span>
                    <span className="od-settings-value">{density}</span>
                  </div>
                  <div className="od-settings-note">
                    Theme, font, and density are set live from the shell's theme
                    rail so changes preview instantly; this tab mirrors the
                    active values.
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
