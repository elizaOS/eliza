// odysseus skills manager (static/js/skills.js). Lists the agent's skills with
// enable/disable toggles + scan-status badges, reusing eliza's skills backend
// (client.getSkills / enableSkill / disableSkill — the REUSED-EXISTING-PLUGIN
// path: @elizaos/plugin-agent-skills). Edit/test/audit/publish land later.

import type { SkillInfo } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export function SkillsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    void client
      .getSkills()
      .then((r) => setSkills(r.skills))
      .catch(() => setSkills([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
    load();
  }, [open, load]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
    : skills;
  const enabledCount = skills.filter((s) => s.enabled).length;

  const toggle = (s: SkillInfo) => {
    const op = s.enabled ? client.disableSkill(s.id) : client.enableSkill(s.id);
    void op.then(load).catch(() => {});
  };

  return (
    <div
      className="od-search-overlay"
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
      <div className="od-search-panel od-mem-panel">
        <div className="od-mem-head">
          <span className="od-mem-title">Skills</span>
          <span className="od-mem-stats">
            {enabledCount} / {skills.length} enabled
          </span>
        </div>
        <input
          ref={inputRef}
          className="od-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder="Search skills…"
          aria-label="Search skills"
        />
        <div className="od-search-list">
          {filtered.length === 0 ? (
            <div className="od-search-empty">No skills.</div>
          ) : (
            filtered.map((s) => (
              <div className="od-skill-item" key={s.id}>
                <div className="od-skill-info">
                  <div className="od-skill-name">
                    {s.name}
                    {s.scanStatus && s.scanStatus !== "clean" ? (
                      <span className="od-skill-scan">{s.scanStatus}</span>
                    ) : null}
                  </div>
                  <div className="od-skill-desc">{s.description}</div>
                </div>
                <button
                  type="button"
                  className={`od-skill-toggle${s.enabled ? " on" : ""}`}
                  onClick={() => toggle(s)}
                  aria-pressed={s.enabled}
                  title={s.enabled ? "Disable skill" : "Enable skill"}
                >
                  {s.enabled ? "On" : "Off"}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
