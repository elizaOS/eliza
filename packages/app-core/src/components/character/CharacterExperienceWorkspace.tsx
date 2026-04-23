import { Button, Input, Textarea } from "@elizaos/ui";
import { useEffect, useMemo, useState } from "react";
import type {
  CharacterExperienceDraft,
  CharacterExperienceRecord,
} from "./character-hub-types";

function formatTimestamp(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function normalizeDraft(
  experience: CharacterExperienceRecord | null | undefined,
): CharacterExperienceDraft {
  return {
    learning: experience?.learning ?? "",
    importance: experience?.importance ?? 0.5,
    confidence: experience?.confidence ?? 0.5,
    tags: experience?.tags.join(", ") ?? "",
  };
}

function outcomeAccent(outcome: string): string {
  switch (outcome) {
    case "positive":
      return "text-status-success border-status-success/30 bg-status-success-bg";
    case "negative":
      return "text-status-danger border-status-danger/30 bg-status-danger-bg";
    case "mixed":
      return "text-status-warning border-status-warning/30 bg-status-warning-bg";
    default:
      return "text-status-info border-status-info/30 bg-status-info-bg";
  }
}

export function CharacterExperienceWorkspace({
  experiences,
  selectedExperienceId,
  onSelectExperience,
  onSaveExperience,
  onDeleteExperience,
  savingExperienceId,
  deletingExperienceId,
}: {
  experiences: CharacterExperienceRecord[];
  selectedExperienceId: string | null;
  onSelectExperience: (experienceId: string) => void;
  onSaveExperience?: (
    experience: CharacterExperienceRecord,
    draft: CharacterExperienceDraft,
  ) => void;
  onDeleteExperience?: (experience: CharacterExperienceRecord) => void;
  savingExperienceId?: string | null;
  deletingExperienceId?: string | null;
}) {
  const selectedExperience = useMemo(
    () =>
      experiences.find(
        (experience) => experience.id === selectedExperienceId,
      ) ??
      experiences[0] ??
      null,
    [experiences, selectedExperienceId],
  );
  const [draft, setDraft] = useState<CharacterExperienceDraft>(
    normalizeDraft(selectedExperience),
  );

  useEffect(() => {
    setDraft(normalizeDraft(selectedExperience));
  }, [selectedExperience]);

  if (experiences.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-border/40 bg-bg-muted/20 px-5 py-8 text-sm text-muted">
        No experiences recorded yet.
      </section>
    );
  }

  return (
    <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
      <div className="flex min-h-[24rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-bg/70">
        <div className="border-b border-border/30 px-4 py-3">
          <h3 className="text-base font-semibold text-txt">Experience</h3>
          <p className="text-sm text-muted">
            Review what the agent learned and edit the takeaway when needed.
          </p>
        </div>
        <div className="custom-scrollbar flex min-w-0 flex-1 flex-col overflow-y-auto">
          {experiences.map((experience) => {
            const isSelected = experience.id === selectedExperience?.id;
            return (
              <button
                key={experience.id}
                type="button"
                className={`flex min-w-0 flex-col items-start gap-2 border-b border-border/20 px-4 py-4 text-left transition-colors hover:bg-bg-muted/20 ${isSelected ? "bg-bg-muted/25" : ""}`}
                onClick={() => onSelectExperience(experience.id)}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="rounded-full border border-border/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    {experience.type}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] ${outcomeAccent(experience.outcome)}`}
                  >
                    {experience.outcome}
                  </span>
                </div>
                <h4 className="line-clamp-2 text-sm font-semibold text-txt">
                  {experience.learning ||
                    experience.result ||
                    experience.context}
                </h4>
                <p className="line-clamp-2 text-sm text-muted-strong">
                  {experience.context}
                </p>
                <span className="text-xs text-muted">
                  {formatTimestamp(experience.createdAt)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {selectedExperience ? (
        <div className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border/40 bg-bg/70 px-4 py-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="rounded-full border border-border/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                  {selectedExperience.type}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] ${outcomeAccent(selectedExperience.outcome)}`}
                >
                  {selectedExperience.outcome}
                </span>
                {selectedExperience.domain ? (
                  <span className="rounded-full border border-border/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    {selectedExperience.domain}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-muted">
                Created {formatTimestamp(selectedExperience.createdAt)}
                {selectedExperience.updatedAt
                  ? ` · Updated ${formatTimestamp(selectedExperience.updatedAt)}`
                  : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onDeleteExperience ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-lg"
                  disabled={deletingExperienceId === selectedExperience.id}
                  onClick={() => onDeleteExperience(selectedExperience)}
                >
                  {deletingExperienceId === selectedExperience.id
                    ? "Deleting..."
                    : "Delete"}
                </Button>
              ) : null}
              {onSaveExperience ? (
                <Button
                  type="button"
                  size="sm"
                  className="rounded-lg"
                  disabled={savingExperienceId === selectedExperience.id}
                  onClick={() => onSaveExperience(selectedExperience, draft)}
                >
                  {savingExperienceId === selectedExperience.id
                    ? "Saving..."
                    : "Save"}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border/30 bg-bg-muted/20 p-3">
              <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                Context
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
                {selectedExperience.context}
              </p>
            </div>
            <div className="rounded-xl border border-border/30 bg-bg-muted/20 p-3">
              <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                Action
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
                {selectedExperience.action}
              </p>
            </div>
            <div className="rounded-xl border border-border/30 bg-bg-muted/20 p-3 lg:col-span-2">
              <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                Result
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
                {selectedExperience.result}
              </p>
            </div>
          </div>

          <label
            htmlFor={`experience-learning-${selectedExperience.id}`}
            className="flex min-w-0 flex-col gap-2"
          >
            <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
              Learning
            </span>
            <Textarea
              id={`experience-learning-${selectedExperience.id}`}
              value={draft.learning}
              rows={8}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  learning: event.target.value,
                }))
              }
              className="min-h-[10rem] resize-y rounded-xl border-border/40 bg-bg-muted/15 font-mono text-sm leading-relaxed"
            />
          </label>

          <div className="grid gap-4 md:grid-cols-3">
            <label
              htmlFor={`experience-importance-${selectedExperience.id}`}
              className="flex min-w-0 flex-col gap-2"
            >
              <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                Importance
              </span>
              <Input
                id={`experience-importance-${selectedExperience.id}`}
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={String(draft.importance)}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    importance: Number(event.target.value || 0),
                  }))
                }
                className="rounded-xl border-border/40 bg-bg-muted/15"
              />
            </label>
            <label
              htmlFor={`experience-confidence-${selectedExperience.id}`}
              className="flex min-w-0 flex-col gap-2"
            >
              <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                Confidence
              </span>
              <Input
                id={`experience-confidence-${selectedExperience.id}`}
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={String(draft.confidence)}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    confidence: Number(event.target.value || 0),
                  }))
                }
                className="rounded-xl border-border/40 bg-bg-muted/15"
              />
            </label>
            <label
              htmlFor={`experience-tags-${selectedExperience.id}`}
              className="flex min-w-0 flex-col gap-2"
            >
              <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                Tags
              </span>
              <Input
                id={`experience-tags-${selectedExperience.id}`}
                type="text"
                value={draft.tags}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    tags: event.target.value,
                  }))
                }
                className="rounded-xl border-border/40 bg-bg-muted/15"
              />
            </label>
          </div>

          {selectedExperience.previousBelief ||
          selectedExperience.correctedBelief ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-border/30 bg-bg-muted/20 p-3">
                <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                  Previous belief
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
                  {selectedExperience.previousBelief || "Not recorded."}
                </p>
              </div>
              <div className="rounded-xl border border-border/30 bg-bg-muted/20 p-3">
                <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                  Corrected belief
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
                  {selectedExperience.correctedBelief || "Not recorded."}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
