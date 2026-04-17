/**
 * Settings → Learned Skills panel.
 *
 * Surfaces the curated learning loop's outputs: skills the agent extracted
 * from successful trajectories (`agent-generated`) and refinements it
 * applied to existing skills (`agent-refined`). Human-authored skills are
 * filtered out — they live in the standard skills view.
 *
 * Backend contract:
 *   GET    /api/skills/curated                            → list
 *   POST   /api/skills/curated/:name/promote              → proposed → active
 *   POST   /api/skills/curated/:name/disable              → active → disabled
 *   DELETE /api/skills/curated/:name                      → remove
 */

import { Button } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";

type CuratedStatus = "active" | "proposed" | "disabled";
type CuratedSource = "human" | "agent-generated" | "agent-refined";

interface CuratedSkill {
  name: string;
  description: string;
  source: CuratedSource;
  derivedFromTrajectory?: string;
  createdAt: string;
  refinedCount: number;
  lastEvalScore?: number;
  status: CuratedStatus;
}

interface ListResponse {
  ok: boolean;
  skills: CuratedSkill[];
  counts: { active: number; proposed: number; disabled: number };
}

function formatScore(score: number | undefined): string {
  if (score === undefined) return "—";
  return `${Math.round(score * 100)}%`;
}

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

export function LearnedSkillsPanel() {
  const [skills, setSkills] = useState<CuratedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = (await client.fetch("/api/skills/curated")) as ListResponse;
      // Only show agent-derived skills; human skills live elsewhere.
      const filtered = res.skills.filter((s) => s.source !== "human");
      setSkills(filtered);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grouped = useMemo(() => {
    const proposed = skills.filter((s) => s.status === "proposed");
    const active = skills.filter((s) => s.status === "active");
    const disabled = skills.filter((s) => s.status === "disabled");
    return { proposed, active, disabled };
  }, [skills]);

  const performAction = useCallback(
    async (
      name: string,
      method: "POST" | "DELETE",
      action: "promote" | "disable" | "delete",
    ) => {
      setBusyName(name);
      setErrorMessage(null);
      try {
        const path =
          action === "delete"
            ? `/api/skills/curated/${encodeURIComponent(name)}`
            : `/api/skills/curated/${encodeURIComponent(name)}/${action}`;
        await client.fetch(path, { method });
        await refresh();
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyName(null);
      }
    },
    [refresh],
  );

  return (
    <section className="space-y-3 rounded-lg border border-default bg-bg p-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold text-txt">Learned Skills</h2>
        <p className="text-xs text-muted">
          Skills the agent has drafted or refined from real trajectories.
          Promote a proposal to start using it, disable to keep it on disk but
          inactive, or delete to remove.
        </p>
      </header>

      {errorMessage ? (
        <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">
          {errorMessage}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted">
          {loading
            ? "Loading…"
            : `${grouped.proposed.length} proposed · ${grouped.active.length} active · ${grouped.disabled.length} disabled`}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void refresh();
          }}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      {grouped.proposed.length > 0 ? (
        <SkillSection
          title="Pending proposals"
          skills={grouped.proposed}
          busyName={busyName}
          onPromote={(name) => performAction(name, "POST", "promote")}
          onDelete={(name) => performAction(name, "DELETE", "delete")}
        />
      ) : null}
      {grouped.active.length > 0 ? (
        <SkillSection
          title="Active learned skills"
          skills={grouped.active}
          busyName={busyName}
          onDisable={(name) => performAction(name, "POST", "disable")}
          onDelete={(name) => performAction(name, "DELETE", "delete")}
        />
      ) : null}
      {grouped.disabled.length > 0 ? (
        <SkillSection
          title="Disabled"
          skills={grouped.disabled}
          busyName={busyName}
          onDelete={(name) => performAction(name, "DELETE", "delete")}
        />
      ) : null}

      {!loading &&
      grouped.proposed.length === 0 &&
      grouped.active.length === 0 &&
      grouped.disabled.length === 0 ? (
        <div className="rounded-md border border-dashed border-default p-3 text-xs text-muted">
          No learned skills yet. The agent stages new proposals here after
          successful trajectories.
        </div>
      ) : null}
    </section>
  );
}

interface SkillSectionProps {
  title: string;
  skills: CuratedSkill[];
  busyName: string | null;
  onPromote?: (name: string) => void;
  onDisable?: (name: string) => void;
  onDelete: (name: string) => void;
}

function SkillSection({
  title,
  skills,
  busyName,
  onPromote,
  onDisable,
  onDelete,
}: SkillSectionProps) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
      </div>
      <ul className="space-y-2">
        {skills.map((skill) => (
          <li
            key={skill.name}
            className="rounded-md border border-default bg-bg p-3 space-y-1"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="font-mono text-sm font-semibold text-txt">
                  {skill.name}
                </div>
                <div className="text-xs text-muted">{skill.description}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted">
                  source: {skill.source} · refinedCount: {skill.refinedCount} ·
                  score: {formatScore(skill.lastEvalScore)} · created:{" "}
                  {formatDate(skill.createdAt)}
                </div>
                {skill.derivedFromTrajectory ? (
                  <div className="text-[10px] text-muted">
                    Derived from trajectory:{" "}
                    <a
                      href={`/trajectories/${skill.derivedFromTrajectory}`}
                      className="underline"
                    >
                      {skill.derivedFromTrajectory.slice(0, 8)}…
                    </a>
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {onPromote ? (
                  <Button
                    size="sm"
                    variant="default"
                    disabled={busyName === skill.name}
                    onClick={() => onPromote(skill.name)}
                  >
                    Promote
                  </Button>
                ) : null}
                {onDisable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyName === skill.name}
                    onClick={() => onDisable(skill.name)}
                  >
                    Disable
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyName === skill.name}
                  onClick={() => onDelete(skill.name)}
                >
                  Delete
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
