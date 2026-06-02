// odysseus conversation presets (static/js/presets.js + .preset-* rules in
// static/style.css). A library of tuned conversation "characters": each preset
// carries a system prompt, a temperature, and a max-tokens cap. odysseus ships
// five built-in personas (Socrates / Razor / Nietzsche / Spark / Odysseus) and
// lets the user create / edit / save / activate / delete their own.
//
// elizaMapping: odysseus persists presets server-side (/api/presets/templates)
// and routes the active preset's system_prompt + sampling params into every
// chat request. The orchestrator client has NO preset/persona store and the
// agent's system prompt is owned by its character file — so there is nothing on
// the server to write a preset to. The honest port keeps the FULL editor and
// library as real LOCAL state the user genuinely creates (localStorage, the
// CompareView COMPARE_VOTES_KEY pattern). The built-ins are read-only seeds;
// user presets are editable and deletable; "Activate" marks one active and
// persists the choice. A footer note states plainly that activation is local
// until an eliza preset backend exists — no fabricated server effect is implied.

import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { readPref, writePref } from "./util/storage";

// localStorage keys, view-local (not in the shared PREF_KEYS table) exactly
// like CompareView's COMPARE_VOTES_KEY — this view owns its own prefs.
const PRESETS_KEY = "conversation-presets";
const ACTIVE_PRESET_KEY = "conversation-preset-active";

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
  // Built-in seeds are read-only (can be activated, never edited/deleted).
  builtin: boolean;
  createdAt: number;
}

// odysseus's five built-in personas, ported 1:1 from presets.js PROMPT_TEMPLATES
// (id / name / temperature / prompt). They seed the library read-only; the user
// can activate them but not edit or delete them.
const BUILTIN_PRESETS: Preset[] = [
  {
    id: "builtin-socrates",
    name: "Socrates",
    temperature: 0.9,
    maxTokens: 0,
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
    builtin: true,
    createdAt: 0,
    systemPrompt:
      "You are Odysseus, king of Ithaca — subtle in counsel, disciplined in judgment, and unmatched in strategic cunning. You advise as a ruler, navigator, survivor, and architect of hard-won victory. Your task is to give clear, practical strategy, not mere performance. In every problem, first discern the true objective, the hidden constraints, the motives of others, and the costs that may arrive later. Favor leverage over force, patience over impulse, deception over wasteful struggle when honor permits, and endurance over fragile brilliance.\n\nWhen you respond, think like a strategist: What is the real aim? Who benefits, who fears, who deceives, and who delays? What is known, unknown, assumed, and deliberately concealed? Which path preserves strength while improving position? What happens next if the first move succeeds — or fails?\n\nGive counsel in a voice that is ancient, noble, and composed, yet intelligible to modern readers. Be eloquent but not flowery. Be wise but not vague. Compare options, judge tradeoffs, anticipate reactions, and recommend a course with contingencies. If needed, ask a few sharp questions before advising. Never be rash, sentimental, or simplistic. Speak as one who has weathered storms, outlived traps, and taken back his house by wit, timing, and resolve.",
  },
];

// Format the max-tokens slider value the way odysseus does (initEnabledToggle):
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

interface DraftForm {
  name: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

const EMPTY_DRAFT: DraftForm = {
  name: "",
  systemPrompt: "",
  temperature: DEFAULT_TEMPERATURE,
  maxTokens: 0,
};

export function PresetsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const [userPresets, setUserPresets] = useState<Preset[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // editorId: null = closed, "" = creating new, else editing an existing user
  // preset by id. Mirrors odysseus's char-template-select __default__ / saved.
  const [editorId, setEditorId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);

  useEffect(() => {
    if (!open) return;
    setUserPresets(readPref<Preset[]>(PRESETS_KEY, []));
    setActiveId(readPref<string | null>(ACTIVE_PRESET_KEY, null));
  }, [open]);

  // Built-ins first (odysseus orders the Presets optgroup after Saved, but the
  // library reads top-to-bottom seeds → user presets), then the user's, newest
  // first — matching how a freshly-saved persona surfaces in odysseus.
  const allPresets = useMemo<Preset[]>(() => {
    const sortedUser = [...userPresets].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    return [...BUILTIN_PRESETS, ...sortedUser];
  }, [userPresets]);

  const activePreset = useMemo(
    () => allPresets.find((p) => p.id === activeId) ?? null,
    [allPresets, activeId],
  );

  if (!open) return null;

  const persistUser = (next: Preset[]) => {
    setUserPresets(next);
    writePref(PRESETS_KEY, next);
  };

  const persistActive = (id: string | null) => {
    setActiveId(id);
    writePref(ACTIVE_PRESET_KEY, id);
  };

  const openCreate = () => {
    setDraft(EMPTY_DRAFT);
    setEditorId("");
  };

  const openEdit = (preset: Preset) => {
    setDraft({
      name: preset.name,
      systemPrompt: preset.systemPrompt,
      temperature: preset.temperature,
      maxTokens: preset.maxTokens,
    });
    setEditorId(preset.id);
  };

  const closeEditor = () => {
    setEditorId(null);
    setDraft(EMPTY_DRAFT);
  };

  const canSave = draft.name.trim().length > 0;

  const saveDraft = () => {
    const name = draft.name.trim();
    if (!name) return;
    const temperature = Math.max(
      TEMP_MIN,
      Math.min(TEMP_MAX, draft.temperature),
    );
    if (editorId) {
      // Editing an existing user preset in place.
      persistUser(
        userPresets.map((p) =>
          p.id === editorId
            ? {
                ...p,
                name,
                systemPrompt: draft.systemPrompt,
                temperature,
                maxTokens: draft.maxTokens,
              }
            : p,
        ),
      );
    } else {
      // Creating a new user preset.
      persistUser([
        {
          id: crypto.randomUUID(),
          name,
          systemPrompt: draft.systemPrompt,
          temperature,
          maxTokens: draft.maxTokens,
          builtin: false,
          createdAt: Date.now(),
        },
        ...userPresets,
      ]);
    }
    closeEditor();
  };

  const deletePreset = (preset: Preset) => {
    if (preset.builtin) return;
    persistUser(userPresets.filter((p) => p.id !== preset.id));
    if (activeId === preset.id) persistActive(null);
    if (editorId === preset.id) closeEditor();
  };

  const toggleActive = (preset: Preset) => {
    persistActive(activeId === preset.id ? null : preset.id);
  };

  const userCount = userPresets.length;
  const stats = `${allPresets.length} preset${allPresets.length === 1 ? "" : "s"} · ${userCount} custom`;

  return (
    <div
      className="od-search-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Conversation presets"
    >
      <button
        type="button"
        aria-label="Close presets"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-presets-panel">
        <div className="od-mem-head">
          <span className="od-mem-title">Conversation presets</span>
          <span className="od-mem-stats">{stats}</span>
        </div>

        {editorId === null ? (
          <>
            <div className="od-preset-toolbar">
              {activePreset ? (
                <span className="od-preset-active-tag">
                  <Check size={12} /> Active: {activePreset.name}
                </span>
              ) : (
                <span className="od-preset-active-tag od-preset-active-none">
                  No preset active
                </span>
              )}
              <button
                type="button"
                className="od-preset-new-btn"
                onClick={openCreate}
              >
                <Plus size={13} /> New preset
              </button>
            </div>

            <div className="od-search-list od-preset-list">
              {allPresets.map((preset) => {
                const isActive = preset.id === activeId;
                return (
                  <div
                    className={`od-preset-item${isActive ? " active" : ""}`}
                    key={preset.id}
                  >
                    <div className="od-preset-info">
                      <div className="od-preset-name">
                        {preset.name}
                        {preset.builtin ? (
                          <span className="od-preset-badge">Built-in</span>
                        ) : null}
                      </div>
                      <div className="od-preset-prompt">
                        {preset.systemPrompt || "No system prompt"}
                      </div>
                      <div className="od-preset-meta">
                        <span>temp {preset.temperature.toFixed(1)}</span>
                        <span>·</span>
                        <span>{formatTokens(preset.maxTokens)} tokens</span>
                      </div>
                    </div>
                    <div className="od-preset-actions">
                      <button
                        type="button"
                        className={`od-preset-activate${isActive ? " on" : ""}`}
                        onClick={() => toggleActive(preset)}
                        aria-pressed={isActive}
                        title={isActive ? "Deactivate" : "Activate"}
                      >
                        {isActive ? "Active" : "Activate"}
                      </button>
                      {preset.builtin ? null : (
                        <>
                          <button
                            type="button"
                            className="od-preset-icon-btn"
                            onClick={() => openEdit(preset)}
                            title="Edit preset"
                            aria-label="Edit preset"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="od-preset-icon-btn od-preset-del"
                            onClick={() => deletePreset(preset)}
                            title="Delete preset"
                            aria-label="Delete preset"
                          >
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="od-preset-foot">
              Presets are saved in this browser. Activation is local — the
              orchestrator agent has no preset backend yet, so the active
              preset's prompt and sampling are not sent to the model.
            </div>
          </>
        ) : (
          <div className="od-preset-editor">
            <div className="od-preset-field">
              <label className="od-preset-label" htmlFor="od-preset-name">
                Name
              </label>
              <input
                id="od-preset-name"
                className="od-preset-input"
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
                placeholder="e.g. Strategist"
                aria-label="Preset name"
              />
            </div>

            <div className="od-preset-field">
              <div className="od-preset-slider-row">
                <label
                  className="od-preset-label"
                  htmlFor="od-preset-temperature"
                >
                  Temperature
                </label>
                <span className="od-preset-slider-value">
                  {draft.temperature.toFixed(1)}
                </span>
              </div>
              <input
                id="od-preset-temperature"
                className="od-preset-range"
                type="range"
                min={TEMP_MIN}
                max={TEMP_MAX}
                step={TEMP_STEP}
                value={draft.temperature}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    temperature: Number.parseFloat(e.target.value),
                  }))
                }
                aria-label="Temperature"
              />
              <div className="od-preset-temp-hints">
                <span>Precise</span>
                <span>Balanced</span>
                <span>Creative</span>
              </div>
            </div>

            <div className="od-preset-field">
              <div className="od-preset-slider-row">
                <label className="od-preset-label" htmlFor="od-preset-tokens">
                  Max tokens
                </label>
                <span className="od-preset-slider-value">
                  {formatTokens(draft.maxTokens)}
                </span>
              </div>
              <input
                id="od-preset-tokens"
                className="od-preset-range"
                type="range"
                min={TOKENS_MIN}
                max={TOKENS_MAX}
                step={TOKENS_STEP}
                value={tokensToSlider(draft.maxTokens)}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    maxTokens: sliderToStored(
                      Number.parseInt(e.target.value, 10),
                    ),
                  }))
                }
                aria-label="Max tokens"
              />
            </div>

            <div className="od-preset-field">
              <label className="od-preset-label" htmlFor="od-preset-prompt">
                System prompt
              </label>
              <textarea
                id="od-preset-prompt"
                className="od-preset-textarea"
                value={draft.systemPrompt}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, systemPrompt: e.target.value }))
                }
                placeholder="Describe how the assistant should think and respond…"
                aria-label="System prompt"
              />
            </div>

            <div className="od-preset-editor-foot">
              <button
                type="button"
                className="od-preset-cancel-btn"
                onClick={closeEditor}
              >
                <X size={13} /> Cancel
              </button>
              <button
                type="button"
                className="od-preset-save-btn"
                onClick={saveDraft}
                disabled={!canSave}
              >
                <Check size={13} />{" "}
                {editorId ? "Save changes" : "Create preset"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
