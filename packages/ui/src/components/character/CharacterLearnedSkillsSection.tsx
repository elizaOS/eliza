import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { client } from "../../api/client";
import { useFetchData } from "../../hooks";

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
  skills: CuratedSkill[];
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

export function CharacterLearnedSkillsSection() {
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(
    null,
  );
  const [busyName, setBusyName] = useState<string | null>(null);

  const fetchState = useFetchData<CuratedSkill[]>(async (signal) => {
    const res = (await client.fetch("/api/skills/curated", {
      signal,
    })) as ListResponse;
    return res.skills.filter((s) => s.source !== "human");
  }, []);

  const skills = fetchState.status === "success" ? fetchState.data : [];
  const loading = fetchState.status === "loading";
  const fetchErrorMessage =
    fetchState.status === "error" ? fetchState.error.message : null;
  const errorMessage = actionErrorMessage ?? fetchErrorMessage;
  const refresh = fetchState.refetch;

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
      setActionErrorMessage(null);
      try {
        const path =
          action === "delete"
            ? `/api/skills/curated/${encodeURIComponent(name)}`
            : `/api/skills/curated/${encodeURIComponent(name)}/${action}`;
        await client.fetch(path, { method });
        refresh();
      } catch (err) {
        setActionErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyName(null);
      }
    },
    [refresh],
  );

  const isEmpty =
    !loading &&
    grouped.proposed.length === 0 &&
    grouped.active.length === 0 &&
    grouped.disabled.length === 0;

  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border/40 bg-bg/70 px-4 py-4"
      data-testid="character-learned-skills-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-txt">Skills</h2>
          <div className="mt-1 text-2xs text-muted">
            {loading
              ? "Loading"
              : `${grouped.proposed.length} proposed · ${grouped.active.length} active · ${grouped.disabled.length} disabled`}
          </div>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 rounded-lg"
          onClick={() => {
            setActionErrorMessage(null);
            refresh();
          }}
          disabled={loading}
          aria-label="Refresh learned skills"
          title="Refresh"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        {errorMessage ? (
          <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2.5 text-xs-tight leading-5 text-danger">
            {errorMessage}
          </div>
        ) : null}

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

        {isEmpty ? (
          <div className="rounded-xl border border-dashed border-border/60 bg-bg-hover/40 px-3 py-3 text-xs-tight leading-5 text-muted">
            I haven&rsquo;t picked up any abilities yet. Browse the catalog or
            add one by example, and I&rsquo;ll start using it.
          </div>
        ) : null}
      </div>
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
    <div className="flex flex-col gap-2">
      <div className="text-2xs font-semibold uppercase tracking-wide text-muted">
        {title}
      </div>
      <ul className="flex flex-col gap-2">
        {skills.map((skill) => (
          <li key={skill.name}>
            <Card className="border-border/50 bg-bg-hover/60 shadow-none">
              <CardContent className="flex flex-col gap-2 px-3 py-3 text-xs-tight">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="font-mono text-sm font-semibold text-txt">
                      {skill.name}
                    </div>
                    <div className="text-xs-tight text-muted">
                      {skill.description}
                    </div>
                    <div className="flex flex-wrap gap-x-2 gap-y-1 text-2xs uppercase tracking-wide text-muted">
                      <span>{skill.source}</span>
                      <span>{skill.refinedCount} refinements</span>
                      <span>{formatScore(skill.lastEvalScore)} score</span>
                      <span>{formatDate(skill.createdAt)}</span>
                    </div>
                    {skill.derivedFromTrajectory ? (
                      <div className="text-2xs text-muted">
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
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
