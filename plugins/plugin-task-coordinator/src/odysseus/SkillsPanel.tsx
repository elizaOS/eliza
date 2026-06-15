// odysseus skills manager (static/js/skills.js + index.html Skills tab). Lists
// the agent's skills with a sort/filter toolbar, expandable cards that load +
// edit the SKILL.md source, and per-card actions (Enable/Disable, Edit, Delete),
// reusing eliza's skills backend (@elizaos/plugin-agent-skills via the
// @elizaos/ui client — the REUSED-EXISTING-PLUGIN path).
//
// Fidelity note vs odysseus: odysseus models skills as draft/published and
// surfaces confidence %, uses, audit verdicts, duplicate detection, a sandbox
// "Test" run and a bulk "Audit all" loop. eliza's skills backend has none of
// those — its real lifecycle field is `enabled` (a skill is injected into
// context when enabled), plus an optional security `scanStatus`. So we keep the
// odysseus card/toolbar/expand/edit/delete surface 1:1 but drive the lifecycle
// control off the real `enabled` field rather than fabricating a publish state,
// confidence, uses, test or audit affordances that route nowhere.
//
// odysseus unifies Skills into the one "Brain" modal as a tab. To support that
// without duplicating the whole card surface, the toolbar/search/add/grid body
// is exported as <SkillsContent /> and reused by MemoryPanel's Skills tab; the
// standalone SkillsPanel (still opened from the icon rail) wraps that body in
// the same draggable window chrome the other tool views use.

import type { SkillInfo } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  ChevronDown,
  Minus,
  MoreVertical,
  Plus,
  Power,
  PowerOff,
  Save,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";

type SkillSort = "name" | "status";
type SkillFilter = "all" | "enabled" | "disabled";

interface SourceState {
  content: string;
  loading: boolean;
  failed: boolean;
}

function sortSkills(list: SkillInfo[], sort: SkillSort): SkillInfo[] {
  const next = [...list];
  if (sort === "status") {
    // Enabled first, then alpha — surfaces the live (injected) skills on top.
    next.sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
    );
  } else {
    next.sort((a, b) => a.name.localeCompare(b.name));
  }
  return next;
}

/**
 * Skills tab body — toolbar + search + add + card grid, with no window chrome
 * of its own. Rendered both standalone (inside SkillsPanel's window) and inline
 * as the Brain modal's Skills tab. `onCountChange` lets the host surface the
 * enabled/total count in the tab label, matching odysseus's #skills-count.
 */
export function SkillsContent({
  active,
  onClose,
  onCountChange,
}: {
  active: boolean;
  onClose: () => void;
  onCountChange?: (enabled: number, total: number) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SkillSort>("status");
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, SourceState>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [addDesc, setAddDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    void client
      .getSkills()
      .then((r) => {
        setSkills(r.skills);
        setLoading(false);
      })
      .catch(() => {
        setSkills([]);
        setLoading(false);
        setFailed(true);
      });
  }, []);

  useEffect(() => {
    if (!active) return;
    setQuery("");
    setExpandedId(null);
    setMenuId(null);
    setEditingId(null);
    setConfirmDeleteId(null);
    setAdding(false);
    setSources({});
    inputRef.current?.focus();
    load();
  }, [active, load]);

  const enabledCount = skills.filter((s) => s.enabled).length;
  useEffect(() => {
    onCountChange?.(enabledCount, skills.length);
  }, [enabledCount, skills.length, onCountChange]);

  if (!active) return null;

  const q = query.trim().toLowerCase();
  const matched = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
    : skills;
  const byFilter = matched.filter((s) =>
    filter === "enabled"
      ? s.enabled
      : filter === "disabled"
        ? !s.enabled
        : true,
  );
  const visible = sortSkills(byFilter, sort);

  const toggleEnabled = (s: SkillInfo) => {
    setMenuId(null);
    const op = s.enabled ? client.disableSkill(s.id) : client.enableSkill(s.id);
    void op
      .then((r) => {
        setSkills((prev) => prev.map((x) => (x.id === s.id ? r.skill : x)));
      })
      .catch(() => {});
  };

  const toggleExpand = (s: SkillInfo) => {
    setMenuId(null);
    setEditingId(null);
    if (expandedId === s.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(s.id);
    // Refetch when never loaded OR a prior load failed; only skip when a load
    // is in flight or already succeeded (a failed source caches content:"" with
    // failed:true, so don't treat that empty string as "already loaded").
    const cached = sources[s.id];
    if (cached?.loading || (cached?.content !== undefined && !cached.failed))
      return;
    setSources((prev) => ({
      ...prev,
      [s.id]: { content: "", loading: true, failed: false },
    }));
    void client
      .getSkillSource(s.id)
      .then((r) => {
        setSources((prev) => ({
          ...prev,
          [s.id]: { content: r.content, loading: false, failed: false },
        }));
      })
      .catch(() => {
        setSources((prev) => ({
          ...prev,
          [s.id]: { content: "", loading: false, failed: true },
        }));
      });
  };

  const startEdit = (s: SkillInfo) => {
    setMenuId(null);
    const begin = (content: string) => {
      setEditDraft(content);
      setEditingId(s.id);
    };
    if (expandedId !== s.id) setExpandedId(s.id);
    const existing = sources[s.id];
    // Only open the editor from cache for a genuinely-loaded source. A failed
    // load caches content:"" (failed:true); opening that and saving would
    // overwrite the real SKILL.md with an empty string — so refetch instead.
    if (
      existing?.content !== undefined &&
      !existing.loading &&
      !existing.failed
    ) {
      begin(existing.content);
      return;
    }
    setSources((prev) => ({
      ...prev,
      [s.id]: { content: "", loading: true, failed: false },
    }));
    void client
      .getSkillSource(s.id)
      .then((r) => {
        setSources((prev) => ({
          ...prev,
          [s.id]: { content: r.content, loading: false, failed: false },
        }));
        begin(r.content);
      })
      .catch(() => {
        setSources((prev) => ({
          ...prev,
          [s.id]: { content: "", loading: false, failed: true },
        }));
      });
  };

  const saveEdit = (s: SkillInfo) => {
    setSaving(true);
    void client
      .saveSkillSource(s.id, editDraft)
      .then((r) => {
        setSources((prev) => ({
          ...prev,
          [s.id]: { content: editDraft, loading: false, failed: false },
        }));
        setSkills((prev) => prev.map((x) => (x.id === s.id ? r.skill : x)));
        setEditingId(null);
        setSaving(false);
      })
      .catch(() => setSaving(false));
  };

  // odysseus's master toggle. eliza has no single "all skills" flag, so this is
  // wired honestly to the real per-skill backend: ON = every skill enabled;
  // flipping it bulk-enables (when not all are on) or bulk-disables every skill.
  const allEnabled = skills.length > 0 && enabledCount === skills.length;
  const toggleAll = () => {
    setMenuId(null);
    const turnOn = !allEnabled;
    for (const s of skills) {
      if (s.enabled === turnOn) continue;
      const op = turnOn ? client.enableSkill(s.id) : client.disableSkill(s.id);
      void op
        .then((r) => {
          setSkills((prev) => prev.map((x) => (x.id === s.id ? r.skill : x)));
        })
        .catch(() => {});
    }
  };

  const removeSkill = (s: SkillInfo) => {
    setMenuId(null);
    void client
      .deleteSkill(s.id)
      .then(() => {
        setSkills((prev) => prev.filter((x) => x.id !== s.id));
        if (expandedId === s.id) setExpandedId(null);
        setConfirmDeleteId(null);
      })
      .catch(() => setConfirmDeleteId(null));
  };

  const createSkill = () => {
    const name = addName.trim();
    const description = addDesc.trim();
    if (!name) return;
    setCreating(true);
    void client
      .createSkill(name, description)
      .then((r) => {
        setSkills((prev) => [r.skill, ...prev]);
        setAddName("");
        setAddDesc("");
        setAdding(false);
        setCreating(false);
      })
      .catch(() => setCreating(false));
  };

  return (
    <>
      <div className="od-skills-section-head">
        <span className="od-skills-section-title">Skills</span>
        <span className="od-skills-section-count">
          {skills.length} {skills.length === 1 ? "skill" : "skills"}
        </span>
        <label className="od-admin-switch od-skills-section-switch">
          <input
            type="checkbox"
            checked={allEnabled}
            disabled={skills.length === 0}
            onChange={toggleAll}
            aria-label={allEnabled ? "Disable all skills" : "Enable all skills"}
          />
          <span className="od-admin-slider" />
        </label>
      </div>

      <p className="od-skills-desc">
        Reusable procedures the agent can call via /skill. Enabled skills are
        injected into chat context when relevant.
      </p>

      <div className="od-skills-toolbar">
        <select
          className="od-skills-select"
          value={sort}
          onChange={(e) => {
            const next = e.target.value;
            setSort(next === "name" ? "name" : "status");
          }}
          aria-label="Sort skills"
        >
          <option value="status">Enabled first</option>
          <option value="name">A-Z</option>
        </select>
        <select
          className="od-skills-select"
          value={filter}
          onChange={(e) => {
            const next = e.target.value;
            setFilter(
              next === "enabled"
                ? "enabled"
                : next === "disabled"
                  ? "disabled"
                  : "all",
            );
          }}
          aria-label="Filter skills"
        >
          <option value="all">All skills</option>
          <option value="enabled">Enabled only</option>
          <option value="disabled">Disabled only</option>
        </select>
        <button
          type="button"
          className="od-skills-toolbar-btn"
          onClick={() => {
            setAdding((prev) => !prev);
            setAddName("");
            setAddDesc("");
          }}
          title="Add a new skill"
        >
          <Plus size={11} /> New
        </button>
      </div>

      <input
        ref={inputRef}
        className="od-skills-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        placeholder="Search skills…"
        aria-label="Search skills"
      />

      {adding ? (
        <div className="od-skills-add">
          <input
            className="od-skills-add-input"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="Skill name (e.g. deploy-to-staging)"
            aria-label="New skill name"
          />
          <textarea
            className="od-skills-add-textarea"
            value={addDesc}
            onChange={(e) => setAddDesc(e.target.value)}
            placeholder="When should the agent use this skill?"
            aria-label="New skill description"
            rows={2}
          />
          <div className="od-skills-add-actions">
            <button
              type="button"
              className="od-skills-text-btn"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="od-skills-text-btn od-skills-text-btn-primary"
              onClick={createSkill}
              disabled={!addName.trim() || creating}
            >
              <Plus size={11} /> {creating ? "Creating…" : "Create skill"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="od-skills-grid">
        {visible.length === 0 ? (
          <div className="od-skills-empty">
            {loading
              ? "Loading…"
              : failed
                ? "Failed to load skills."
                : q
                  ? "No skills match your search."
                  : "No skills yet. Use the agent and it will auto-extract them, or add one above."}
          </div>
        ) : (
          visible.map((s) => {
            const expanded = expandedId === s.id;
            const editing = editingId === s.id;
            const src = sources[s.id];
            const confirming = confirmDeleteId === s.id;
            return (
              <div
                className={`od-skills-card${expanded ? " od-skills-card-expanded" : ""}`}
                key={s.id}
              >
                <button
                  type="button"
                  className="od-skills-card-main"
                  onClick={() => toggleExpand(s)}
                  aria-expanded={expanded}
                >
                  <div className="od-skills-content">
                    <div className="od-skills-titlerow">
                      <code className="od-skills-name">{s.name}</code>
                      <span
                        className={`od-skills-status${s.enabled ? " on" : ""}`}
                      >
                        {s.enabled ? "enabled" : "disabled"}
                      </span>
                      {s.scanStatus && s.scanStatus !== "clean" ? (
                        <span
                          className={`od-skills-scan od-skills-scan-${s.scanStatus}`}
                          title={`Security scan: ${s.scanStatus}`}
                        >
                          {s.scanStatus}
                        </span>
                      ) : null}
                      <ChevronDown
                        size={12}
                        className="od-skills-chevron"
                        aria-hidden="true"
                      />
                    </div>
                    {s.description ? (
                      <div className="od-skills-desc-line">{s.description}</div>
                    ) : null}
                  </div>
                </button>

                <span className="od-skills-actions">
                  <button
                    type="button"
                    className="od-skills-item-btn"
                    title="Actions"
                    aria-label="Skill actions"
                    onClick={() =>
                      setMenuId((prev) => (prev === s.id ? null : s.id))
                    }
                  >
                    <MoreVertical size={14} />
                  </button>
                  {menuId === s.id ? (
                    <div className="od-skills-dropdown">
                      <button
                        type="button"
                        className="od-skills-dropdown-item"
                        onClick={() => toggleEnabled(s)}
                      >
                        {s.enabled ? (
                          <>
                            <PowerOff size={14} />
                            <span>Disable</span>
                          </>
                        ) : (
                          <>
                            <Power size={14} />
                            <span>Enable</span>
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        className="od-skills-dropdown-item"
                        onClick={() => startEdit(s)}
                        disabled={src?.loading || src?.failed}
                      >
                        <SquarePen size={14} />
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        className="od-skills-dropdown-item od-skills-dropdown-danger"
                        onClick={() => {
                          setMenuId(null);
                          setConfirmDeleteId(s.id);
                          if (expandedId !== s.id) setExpandedId(s.id);
                        }}
                      >
                        <Trash2 size={14} />
                        <span>Delete</span>
                      </button>
                    </div>
                  ) : null}
                </span>

                {expanded ? (
                  <div className="od-skills-preview">
                    {editing ? (
                      <textarea
                        className="od-skills-editor"
                        spellCheck={false}
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        aria-label={`Edit ${s.name} source`}
                      />
                    ) : (
                      <pre>
                        <code>
                          {src?.loading
                            ? "Loading…"
                            : src?.failed
                              ? "Failed to load SKILL.md."
                              : src?.content
                                ? src.content
                                : "(empty skill)"}
                        </code>
                      </pre>
                    )}

                    {confirming ? (
                      <div className="od-skills-confirm">
                        <span>Delete “{s.name}”? This removes SKILL.md.</span>
                        <button
                          type="button"
                          className="od-skills-text-btn"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="od-skills-text-btn od-skills-text-btn-danger"
                          onClick={() => removeSkill(s)}
                        >
                          <Trash2 size={11} /> Delete
                        </button>
                      </div>
                    ) : (
                      <div className="od-skills-expanded-actions">
                        <button
                          type="button"
                          className="od-skills-text-btn od-skills-text-btn-danger"
                          onClick={() => setConfirmDeleteId(s.id)}
                        >
                          <Trash2 size={11} /> Delete
                        </button>
                        <div className="od-skills-action-group">
                          <button
                            type="button"
                            className="od-skills-text-btn"
                            onClick={() => toggleEnabled(s)}
                          >
                            {s.enabled ? (
                              <>
                                <PowerOff size={11} /> Disable
                              </>
                            ) : (
                              <>
                                <Power size={11} /> Enable
                              </>
                            )}
                          </button>
                          {editing ? (
                            <button
                              type="button"
                              className="od-skills-text-btn od-skills-text-btn-primary"
                              onClick={() => saveEdit(s)}
                              disabled={saving}
                            >
                              <Save size={11} /> {saving ? "Saving…" : "Save"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="od-skills-text-btn"
                              onClick={() => startEdit(s)}
                              disabled={src?.loading || src?.failed}
                            >
                              <SquarePen size={11} /> Edit
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {editing ? (
                      <button
                        type="button"
                        className="od-skills-edit-cancel"
                        onClick={() => setEditingId(null)}
                        title="Discard changes"
                        aria-label="Discard changes"
                      >
                        <X size={11} /> Discard
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

export function SkillsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls(
    "win-skills",
    { w: 560, h: 640 },
    { label: "Skills", icon: "Zap", onClose },
  );
  const [counts, setCounts] = useState<{ enabled: number; total: number }>({
    enabled: 0,
    total: 0,
  });
  const onCountChange = useCallback((enabled: number, total: number) => {
    setCounts({ enabled, total });
  }, []);

  if (!open) return null;
  if (win.minimized) return null;

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Skills"
    >
      <button
        type="button"
        aria-label="Close skills"
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
      <div className="od-search-panel od-skills-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div
          className="od-mem-head od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-mem-title">Skills</span>
          <span className="od-mem-stats">
            {counts.enabled} / {counts.total} enabled
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
            aria-label="Close skills"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <SkillsContent
          active={open}
          onClose={onClose}
          onCountChange={onCountChange}
        />
      </div>
    </div>
  );
}
