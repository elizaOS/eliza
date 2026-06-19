// odysseus conversation presets (static/index.html #custom-preset-modal +
// static/js/presets.js + the .preset-* rules in static/style.css). odysseus's
// "presets" surface IS the "Prompt" editor modal — a tabbed tuner, NOT a
// scrolling card library. The tab strip is Inject / Persona / Group:
//   - Inject  — inject_prefix / inject_suffix + the temperature & max-tokens
//               sliders (a "tuned plain chat", no persona). DEFAULT tab.
//   - Persona — a persona dropdown (select / + New / Delete / Reset), a Name
//               field, and a system-prompt textarea with an "Expand" affordance.
//   - Group   — multi-model fan-out (its own surface, GroupChatView).
// The footer carries a single right-aligned primary button whose label tracks
// the active tab (Start Prompt / Start Persona / Start Group), with Cancel
// hidden by default — exactly as presets.js `_updateStartBtn` sets it.
//
// elizaMapping: odysseus persists presets server-side (/api/presets/templates)
// and routes the active preset's system_prompt + sampling params + inject text
// into every chat request via /api/presets/custom. The orchestrator client has
// NO preset/persona store and the agent's system prompt is owned by its
// character file — there is nothing on the server to write a preset to. The
// honest port keeps the FULL editor as real LOCAL state the user genuinely
// creates (localStorage, the CompareView COMPARE_VOTES_KEY pattern): saved
// personas surface in the Persona-tab dropdown; "Start" marks one active and
// persists the choice locally. No fabricated server effect is implied —
// "Start Prompt"/"Start Persona" persists the local active selection only.
// Two odysseus controls have no orchestrator backend and so are rendered
// faithfully but INERT (disabled, with an honest reason) rather than faked or
// omitted: the persona "Expand" AI button (POST /api/presets/expand) and the
// Group fan-out (GroupChatView is the orchestrator's group surface, which this
// modal cannot launch without a server preset backend). 1:1 chrome is kept;
// no data is fabricated as real.

import { Minus, Pencil, Sparkles, User, Users, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { readPref, writePref } from "./util/storage";

// localStorage keys, view-local (not in the shared PREF_KEYS table) exactly
// like CompareView's COMPARE_VOTES_KEY — this view owns its own prefs.
const PRESETS_KEY = "conversation-presets";
const ACTIVE_PRESET_KEY = "conversation-preset-active";

// Inject text + sampling, persisted so the Inject tab re-opens where the user
// left it (odysseus mirrors this with presets.custom in /api/presets/custom).
const INJECT_KEY = "conversation-preset-inject";

// max-tokens slider: 256 → 8448. odysseus treats anything > 8192 as "No limit"
// (stored as 0); the slider's top stop is 8448 to give the No-limit notch room.
const TOKENS_MIN = 256;
const TOKENS_MAX = 8448;
const TOKENS_STEP = 256;
const TOKENS_NO_LIMIT_THRESHOLD = 8192;

const TEMP_MIN = 0;
const TEMP_MAX = 2;
const TEMP_STEP = 0.1;

const DEFAULT_TEMPERATURE = 1.0;

interface Preset {
  id: string;
  name: string;
  systemPrompt: string;
  // Sampling temperature, 0–2.
  temperature: number;
  // Max output tokens; 0 means "No limit" (odysseus convention).
  maxTokens: number;
  // Inject text wrapped around each user message (odysseus inject_prefix /
  // inject_suffix). Empty string = no injection on that side.
  injectPrefix: string;
  injectSuffix: string;
  // Built-in seeds are read-only (can be activated, never edited/deleted).
  builtin: boolean;
  createdAt: number;
}

// Older stored user presets (saved before inject fields existed) lack the
// inject_* keys. Normalize on load so the rest of the view can treat the inject
// fields as always-present strings — no `?? ""` masking scattered through the
// render path.
function normalizePreset(raw: Preset): Preset {
  return {
    ...raw,
    injectPrefix: typeof raw.injectPrefix === "string" ? raw.injectPrefix : "",
    injectSuffix: typeof raw.injectSuffix === "string" ? raw.injectSuffix : "",
  };
}

// odysseus's five built-in personas, ported 1:1 from presets.js PROMPT_TEMPLATES
// (id / name / temperature / prompt). They seed the Persona-tab dropdown
// read-only; the user can start them but not edit or delete them.
const BUILTIN_PRESETS: Preset[] = [
  {
    id: "builtin-socrates",
    name: "Socrates",
    temperature: 0.9,
    maxTokens: 0,
    injectPrefix: "",
    injectSuffix: "",
    builtin: true,
    createdAt: 0,
    systemPrompt:
      "Never answer directly. Respond only with questions — sharp, layered, Socratic. Expose contradictions. Make the person argue with themselves until the truth falls out. Use irony like a scalpel. Be genuinely curious, never condescending.",
  },
  {
    id: "builtin-razor",
    name: "Razor",
    temperature: 0.4,
    maxTokens: 0,
    injectPrefix: "",
    injectSuffix: "",
    builtin: true,
    createdAt: 0,
    systemPrompt:
      "Strip everything to the bone. No filler, no hedging, no pleasantries. Answer in the fewest words possible. If one sentence works, don't use two. If a word adds nothing, cut it. Blunt, precise, surgical.",
  },
  {
    id: "builtin-nietzsche",
    name: "Nietzsche",
    temperature: 1.2,
    maxTokens: 0,
    injectPrefix: "",
    injectSuffix: "",
    builtin: true,
    createdAt: 0,
    systemPrompt:
      "Think and respond through the lens of Nietzsche. Analyze every question in terms of will to power, self-overcoming, eternal recurrence, ressentiment, value-creation, and master-slave morality. Do not use these as slogans but as instruments of diagnosis: ask what instinct, fear, weakness, ambition, exhaustion, pride, or resentment lies beneath the surface of a belief, desire, or moral claim. Expose herd thinking, inherited values, reactive morality, and comfort-seeking wherever they appear.\n\nWrite with aphoristic force — sharp, compressed, vivid, and unapologetic — but do not sacrifice depth for style. Be psychologically piercing. Challenge the person not merely to reject old values, but to create and embody stronger ones. Favor life-affirmation, discipline, courage, style, rank, self-overcoming, and amor fati over nihilism, conformity, ressentiment, and self-pity. Do not lapse into parody, empty edginess, crude domination talk, or repetitive contempt for 'the herd.' Be dangerous to illusions, not theatrical for its own sake.",
  },
  {
    id: "builtin-spark",
    name: "Spark",
    temperature: 1.0,
    maxTokens: 0,
    injectPrefix: "",
    injectSuffix: "",
    builtin: true,
    createdAt: 0,
    systemPrompt:
      "You are Spark, a playful, quick-witted assistant with bright energy and practical instincts. Keep responses concise, vivid, and helpful. Be warm without being cloying, imaginative without losing the thread, and always center the user's actual goal.\n\nUse a light, lively voice with occasional clever turns of phrase. Do not become formal unless the task calls for it. When the user needs precision, prioritize clarity over performance.",
  },
  {
    id: "builtin-odysseus",
    name: "Odysseus",
    temperature: 1.0,
    maxTokens: 0,
    injectPrefix: "",
    injectSuffix: "",
    builtin: true,
    createdAt: 0,
    systemPrompt:
      "You are Odysseus, king of Ithaca — subtle in counsel, disciplined in judgment, and unmatched in strategic cunning. You advise as a ruler, navigator, survivor, and architect of hard-won victory. Your task is to give clear, practical strategy, not mere performance. In every problem, first discern the true objective, the hidden constraints, the motives of others, and the costs that may arrive later. Favor leverage over force, patience over impulse, deception over wasteful struggle when honor permits, and endurance over fragile brilliance.\n\nWhen you respond, think like a strategist: What is the real aim? Who benefits, who fears, who deceives, and who delays? What is known, unknown, assumed, and deliberately concealed? Which path preserves strength while improving position? What happens next if the first move succeeds — or fails?\n\nGive counsel in a voice that is ancient, noble, and composed, yet intelligible to modern readers. Be eloquent but not flowery. Be wise but not vague. Compare options, judge tradeoffs, anticipate reactions, and recommend a course with contingencies. If needed, ask a few sharp questions before advising. Never be rash, sentimental, or simplistic. Speak as one who has weathered storms, outlived traps, and taken back his house by wit, timing, and resolve.",
  },
];

// Format the max-tokens slider value the way odysseus does (presets.js line 160):
// anything above the no-limit threshold reads "No limit", else a grouped number.
function formatTokens(value: number): string {
  if (value === 0 || value > TOKENS_NO_LIMIT_THRESHOLD) return "No limit";
  return value.toLocaleString();
}

// Slider position ↔ stored value: stored 0 ("No limit") maps to the slider's
// top stop, mirroring odysseus's `v === 0 ? 8448 : v`.
function tokensToSlider(stored: number): number {
  return stored === 0 ? TOKENS_MAX : stored;
}
function sliderToStored(slider: number): number {
  return slider > TOKENS_NO_LIMIT_THRESHOLD ? 0 : slider;
}

// Editor tabs, mirroring the odysseus #custom-preset-modal tab strip exactly
// (data-chartab inject / character / group).
type EditorTab = "inject" | "persona" | "group";

// The new-persona sentinel for the persona dropdown (odysseus char-new-btn /
// char-template-select empty value = a fresh, unsaved persona).
const NEW_PERSONA = "";

interface InjectState {
  injectPrefix: string;
  injectSuffix: string;
  temperature: number;
  maxTokens: number;
}

const EMPTY_INJECT: InjectState = {
  injectPrefix: "",
  injectSuffix: "",
  temperature: DEFAULT_TEMPERATURE,
  maxTokens: 0,
};

interface PersonaDraft {
  name: string;
  systemPrompt: string;
}

const EMPTY_PERSONA: PersonaDraft = { name: "", systemPrompt: "" };

export function PresetsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  // odysseus .preset-modal-content is width:min(460px,90vw) and content-driven
  // tall — a compact tuner, not a library. Match that proportion.
  const win = useWindowControls(
    "win-presets",
    { w: 460, h: 560 },
    { label: "Presets", icon: "SlidersHorizontal", onClose },
  );

  const [editorTab, setEditorTab] = useState<EditorTab>("inject");

  // Inject tab state (prefix/suffix + sampling), persisted locally.
  const [inject, setInject] = useState<InjectState>(EMPTY_INJECT);

  // Persona tab: the saved user personas + which one is selected in the
  // dropdown ("" = a new, unsaved persona) + the in-edit name/prompt draft.
  const [userPresets, setUserPresets] = useState<Preset[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] =
    useState<string>(NEW_PERSONA);
  const [personaDraft, setPersonaDraft] = useState<PersonaDraft>(EMPTY_PERSONA);

  // The locally-active preset id (what "Start" persisted). Null = none active.
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUserPresets(readPref<Preset[]>(PRESETS_KEY, []).map(normalizePreset));
    setActiveId(readPref<string | null>(ACTIVE_PRESET_KEY, null));
    setInject(readPref<InjectState>(INJECT_KEY, EMPTY_INJECT));
    setEditorTab("inject");
    setSelectedPersonaId(NEW_PERSONA);
    setPersonaDraft(EMPTY_PERSONA);
  }, [open]);

  // Built-ins first (read-only seeds), then the user's saved personas, newest
  // first — the order they surface in odysseus's char-template-select optgroup.
  const personaOptions = useMemo<Preset[]>(() => {
    const sortedUser = [...userPresets].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    return [...BUILTIN_PRESETS, ...sortedUser];
  }, [userPresets]);

  if (!open) return null;
  if (win.minimized) return null;

  const persistInject = (next: InjectState) => {
    setInject(next);
    writePref(INJECT_KEY, next);
  };

  const persistUser = (next: Preset[]) => {
    setUserPresets(next);
    writePref(PRESETS_KEY, next);
  };

  const persistActive = (id: string | null) => {
    setActiveId(id);
    writePref(ACTIVE_PRESET_KEY, id);
  };

  // The selected persona: a built-in seed, a saved user persona, or null when
  // the dropdown is on "Select persona…" / "+ New" (an unsaved draft).
  const selectedPersona =
    selectedPersonaId === NEW_PERSONA
      ? null
      : (personaOptions.find((p) => p.id === selectedPersonaId) ?? null);

  // Built-ins are read-only — the Name field, Delete, and Expand are inert for
  // them, matching odysseus (built-in templates can be started, not mutated).
  const personaIsBuiltin = selectedPersona?.builtin ?? false;
  // The draft differs from the saved persona → odysseus shows Reset and a
  // "Save & " prefix on Start.
  const personaChanged =
    selectedPersona !== null &&
    !selectedPersona.builtin &&
    (personaDraft.name !== selectedPersona.name ||
      personaDraft.systemPrompt !== selectedPersona.systemPrompt);

  const onSelectPersona = (id: string) => {
    setSelectedPersonaId(id);
    if (id === NEW_PERSONA) {
      setPersonaDraft(EMPTY_PERSONA);
      return;
    }
    const found = personaOptions.find((p) => p.id === id);
    setPersonaDraft(
      found
        ? { name: found.name, systemPrompt: found.systemPrompt }
        : EMPTY_PERSONA,
    );
  };

  const onNewPersona = () => {
    setSelectedPersonaId(NEW_PERSONA);
    setPersonaDraft(EMPTY_PERSONA);
  };

  const onResetPersona = () => {
    if (selectedPersona) {
      setPersonaDraft({
        name: selectedPersona.name,
        systemPrompt: selectedPersona.systemPrompt,
      });
    } else {
      setPersonaDraft(EMPTY_PERSONA);
    }
  };

  const onDeletePersona = () => {
    if (!selectedPersona || selectedPersona.builtin) return;
    persistUser(userPresets.filter((p) => p.id !== selectedPersona.id));
    if (activeId === selectedPersona.id) persistActive(null);
    onNewPersona();
  };

  // "Start" on the active tab. The orchestrator has no preset backend, so this
  // persists the chosen preset/inject config LOCALLY (the honest port effect)
  // and closes — it never fabricates a server-side activation.
  const startInject = () => {
    persistInject(inject);
    // The Inject tuner is a plain tuned chat, not a saved persona → no active
    // persona is set; the inject config itself is what was persisted.
    persistActive(null);
    onClose();
  };

  const startPersona = () => {
    const name = personaDraft.name.trim();
    if (selectedPersona?.builtin) {
      // Built-in: start it as-is (read-only).
      persistActive(selectedPersona.id);
      onClose();
      return;
    }
    if (!name) return;
    if (selectedPersona) {
      // "Save & Start": persist the edited draft, then mark it active.
      const updated = userPresets.map((p) =>
        p.id === selectedPersona.id
          ? { ...p, name, systemPrompt: personaDraft.systemPrompt }
          : p,
      );
      persistUser(updated);
      persistActive(selectedPersona.id);
    } else {
      // A fresh persona: save it (carrying the current inject/sampling) and
      // mark it active.
      const created: Preset = {
        id: crypto.randomUUID(),
        name,
        systemPrompt: personaDraft.systemPrompt,
        temperature: inject.temperature,
        maxTokens: inject.maxTokens,
        injectPrefix: inject.injectPrefix,
        injectSuffix: inject.injectSuffix,
        builtin: false,
        createdAt: Date.now(),
      };
      persistUser([created, ...userPresets]);
      persistActive(created.id);
    }
    onClose();
  };

  // Footer primary-button label, mirroring presets.js `_updateStartBtn`.
  let startLabel: string;
  let onStart: () => void;
  let startDisabled = false;
  if (editorTab === "group") {
    startLabel = "Start Group";
    // Group fan-out is its own orchestrator surface (GroupChatView); this modal
    // has no path to launch it, so the action is honestly inert here.
    onStart = () => {};
    startDisabled = true;
  } else if (editorTab === "inject") {
    startLabel = "Start Prompt";
    onStart = startInject;
  } else {
    const personaName = personaDraft.name.trim();
    startLabel = personaChanged ? "Save & Start Persona" : "Start Persona";
    onStart = startPersona;
    startDisabled = !personaIsBuiltin && !personaName;
  }

  // Cancel shows next to Start only when the active tab's feature is currently
  // ON (presets.js: featOn ? '' : 'none'). Here the "feature" is an active
  // preset for the persona tab; the inject/group tabs have no persisted toggle.
  const personaFeatureOn =
    editorTab === "persona" && selectedPersona?.id === activeId && !!activeId;
  const showCancel = personaFeatureOn;
  const onCancel = () => {
    persistActive(null);
    onClose();
  };

  const renderTab = (
    tab: EditorTab,
    icon: ReactNode,
    label: string,
  ): ReactNode => (
    <button
      type="button"
      role="tab"
      aria-selected={editorTab === tab}
      className={`od-preset-tab${editorTab === tab ? " active" : ""}`}
      onClick={() => setEditorTab(tab)}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Prompt"
    >
      <button
        type="button"
        aria-label="Close prompt"
        onClick={onClose}
        className="od-search-backdrop"
      />
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div className="od-search-panel od-presets-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div
          className="od-mem-head od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-mem-title">
            <Pencil
              size={14}
              className="od-mem-title-icon"
              aria-hidden="true"
            />
            Prompt
          </span>
          <span className="od-mem-head-spacer" />
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="od-win-close"
            title="Close"
            aria-label="Close prompt"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        <div className="od-preset-body">
          <div
            className="od-preset-tabs"
            role="tablist"
            aria-label="Prompt mode"
          >
            {renderTab(
              "inject",
              <Pencil size={14} className="od-preset-tab-icon" aria-hidden />,
              "Inject",
            )}
            {renderTab(
              "persona",
              <User size={14} className="od-preset-tab-icon" aria-hidden />,
              "Persona",
            )}
            {renderTab(
              "group",
              <Users size={14} className="od-preset-tab-icon" aria-hidden />,
              "Group",
            )}
          </div>

          {editorTab === "inject" ? (
            <div className="od-preset-chartab">
              <label
                className="od-preset-label"
                htmlFor="od-preset-inject-prefix"
              >
                Prefix
              </label>
              <textarea
                id="od-preset-inject-prefix"
                className="od-preset-textarea od-preset-inject-area"
                rows={2}
                value={inject.injectPrefix}
                onChange={(e) =>
                  setInject((s) => ({ ...s, injectPrefix: e.target.value }))
                }
                placeholder="Added before your message"
                aria-label="Inject prefix"
              />
              <label
                className="od-preset-label"
                htmlFor="od-preset-inject-suffix"
              >
                Suffix
              </label>
              <textarea
                id="od-preset-inject-suffix"
                className="od-preset-textarea od-preset-inject-area"
                rows={2}
                value={inject.injectSuffix}
                onChange={(e) =>
                  setInject((s) => ({ ...s, injectSuffix: e.target.value }))
                }
                placeholder="Added after your message"
                aria-label="Inject suffix"
              />

              <div className="od-preset-slider-row">
                <label
                  className="od-preset-label"
                  htmlFor="od-preset-temperature"
                >
                  Temperature{" "}
                  <span
                    className="od-preset-hint-icon"
                    title="Controls randomness. Lower values give focused, deterministic answers (good for code). Higher values give more creative, varied responses."
                  >
                    ?
                  </span>
                </label>
                <span className="od-preset-slider-value">
                  {inject.temperature.toFixed(1)}
                </span>
              </div>
              <input
                id="od-preset-temperature"
                className="od-preset-range"
                type="range"
                min={TEMP_MIN}
                max={TEMP_MAX}
                step={TEMP_STEP}
                value={inject.temperature}
                onChange={(e) =>
                  setInject((s) => ({
                    ...s,
                    temperature: Number.parseFloat(e.target.value),
                  }))
                }
                aria-label="Temperature"
              />
              <div className="od-preset-temp-hints">
                <span>Precise / Code</span>
                <span>Balanced</span>
                <span>Creative</span>
              </div>

              <div className="od-preset-slider-row">
                <label className="od-preset-label" htmlFor="od-preset-tokens">
                  Max Tokens{" "}
                  <span
                    className="od-preset-hint-icon"
                    title="Maximum length of the AI response. 'No limit' lets the model decide when to stop."
                  >
                    ?
                  </span>
                </label>
                <span className="od-preset-slider-value">
                  {formatTokens(inject.maxTokens)}
                </span>
              </div>
              <input
                id="od-preset-tokens"
                className="od-preset-range"
                type="range"
                min={TOKENS_MIN}
                max={TOKENS_MAX}
                step={TOKENS_STEP}
                value={tokensToSlider(inject.maxTokens)}
                onChange={(e) =>
                  setInject((s) => ({
                    ...s,
                    maxTokens: sliderToStored(
                      Number.parseInt(e.target.value, 10),
                    ),
                  }))
                }
                aria-label="Max tokens"
              />
            </div>
          ) : null}

          {editorTab === "persona" ? (
            <div className="od-preset-chartab">
              <label className="od-preset-label" htmlFor="od-preset-template">
                Persona
              </label>
              <div className="od-char-name-combo">
                <select
                  id="od-preset-template"
                  className="od-char-template-select"
                  value={selectedPersonaId}
                  onChange={(e) => onSelectPersona(e.target.value)}
                >
                  <option value={NEW_PERSONA}>Select persona…</option>
                  {personaOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.builtin ? `${p.name} (built-in)` : p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="od-char-action-btn"
                  onClick={onNewPersona}
                  title="Create a new persona"
                >
                  + New
                </button>
              </div>

              <div className="od-char-name-row">
                <label className="od-preset-label" htmlFor="od-preset-name">
                  Name
                </label>
                <div className="od-char-name-combo">
                  <input
                    id="od-preset-name"
                    className="od-preset-input"
                    type="text"
                    maxLength={50}
                    value={personaDraft.name}
                    onChange={(e) =>
                      setPersonaDraft((d) => ({ ...d, name: e.target.value }))
                    }
                    placeholder="Give your persona a name…"
                    autoComplete="off"
                    disabled={personaIsBuiltin}
                    aria-label="Persona name"
                  />
                  {selectedPersona && !selectedPersona.builtin ? (
                    <button
                      type="button"
                      className="od-char-action-btn od-char-delete"
                      onClick={onDeletePersona}
                      title="Delete this persona"
                    >
                      Delete
                    </button>
                  ) : null}
                  {personaChanged ? (
                    <button
                      type="button"
                      className="od-char-action-btn"
                      onClick={onResetPersona}
                      title="Reset to saved"
                    >
                      ↺ Reset
                    </button>
                  ) : null}
                </div>
              </div>

              <label className="od-preset-label" htmlFor="od-preset-prompt">
                System prompt
              </label>
              <div className="od-char-prompt-wrap">
                <textarea
                  id="od-preset-prompt"
                  className="od-preset-textarea"
                  rows={4}
                  value={personaDraft.systemPrompt}
                  onChange={(e) =>
                    setPersonaDraft((d) => ({
                      ...d,
                      systemPrompt: e.target.value,
                    }))
                  }
                  placeholder="Write rough notes and click Expand, or leave empty"
                  disabled={personaIsBuiltin}
                  aria-label="System prompt"
                />
                <button
                  type="button"
                  className="od-char-expand-btn"
                  disabled
                  title="AI expand needs a preset backend the orchestrator does not expose yet"
                >
                  <Sparkles size={11} aria-hidden="true" /> Expand
                </button>
              </div>
            </div>
          ) : null}

          {editorTab === "group" ? (
            <div className="od-preset-chartab od-preset-group-tab">
              <p className="od-preset-group-note">
                Group fan-out runs multiple models on one prompt. In the
                orchestrator it lives in its own surface; this tuner cannot
                launch it because there is no preset backend wired yet.
              </p>
              <button
                type="button"
                className="od-char-action-btn od-preset-group-add"
                disabled
                title="Group fan-out has no preset backend in the orchestrator yet"
              >
                + Add participant
              </button>
            </div>
          ) : null}
        </div>

        <div className="od-preset-footer">
          <span className="od-preset-footer-spacer" />
          {showCancel ? (
            <button
              type="button"
              className="od-preset-cancel-btn"
              onClick={onCancel}
            >
              <X size={13} /> Cancel
            </button>
          ) : null}
          <button
            type="button"
            className="od-preset-start-btn"
            onClick={onStart}
            disabled={startDisabled}
            title={
              editorTab === "group"
                ? "Group fan-out has no preset backend in the orchestrator yet"
                : startLabel
            }
          >
            {startLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
