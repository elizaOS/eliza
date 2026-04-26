import { Button, Input, Textarea } from "@elizaos/ui";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../state/TranslationContext";
import type {
  CharacterExperienceDraft,
  CharacterExperienceRecord,
} from "./character-hub-types";

type ReviewFilter = "all" | "needs-review" | "corrected" | "superseded";
type SortMode = "priority" | "newest" | "confidence" | "importance";

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

function clampScore(value: number | null | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatPercent(value: number | null | undefined): string {
  return `${Math.round(clampScore(value) * 100)}%`;
}

function getTimestampMs(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getPriorityScore(experience: CharacterExperienceRecord): number {
  const importance = clampScore(experience.importance);
  const confidence = clampScore(experience.confidence);
  const correctionBoost =
    experience.previousBelief || experience.correctedBelief ? 0.18 : 0;
  const supersessionBoost = experience.supersedes ? 0.08 : 0;
  return (
    importance * 0.64 +
    (1 - confidence) * 0.28 +
    correctionBoost +
    supersessionBoost
  );
}

function needsReview(experience: CharacterExperienceRecord): boolean {
  return (
    clampScore(experience.confidence) < 0.65 ||
    clampScore(experience.importance) >= 0.75 ||
    Boolean(experience.previousBelief || experience.correctedBelief)
  );
}

function compactText(...values: Array<string | null | undefined>): string {
  return values.filter(Boolean).join(" ").toLowerCase();
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]),
  ).sort((left, right) => left.localeCompare(right));
}

function shortId(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

function selectedOrFirst(
  experiences: CharacterExperienceRecord[],
  selectedExperienceId: string | null,
): CharacterExperienceRecord | null {
  return (
    experiences.find((experience) => experience.id === selectedExperienceId) ??
    experiences[0] ??
    null
  );
}

function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/30 bg-bg-muted/15 px-3 py-2">
      <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold leading-tight text-txt">
        {value}
      </div>
      <div className="mt-0.5 truncate text-xs text-muted">{detail}</div>
    </div>
  );
}

function ScoreBar({
  label,
  value,
  explanation,
}: {
  label: string;
  value: number;
  explanation: string;
}) {
  const percent = formatPercent(value);
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-muted-strong">{label}</span>
        <span className="font-mono text-muted">{percent}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-muted">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: percent }}
        />
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">{explanation}</p>
    </div>
  );
}

function EvidencePanel({
  title,
  body,
}: {
  title: string;
  body: string | null | undefined;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/30 bg-bg-muted/15 p-3">
      <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
        {title}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
        {body || "Not recorded."}
      </p>
    </div>
  );
}

function ProvenancePanel({
  experience,
}: {
  experience: CharacterExperienceRecord;
}) {
  const sourceMessageIds = experience.sourceMessageIds ?? [];
  const trajectoryTarget =
    experience.sourceTrajectoryId ?? experience.sourceTrajectoryStepId ?? null;

  return (
    <div className="rounded-xl border border-border/30 bg-bg-muted/10 p-3">
      <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
        Evidence source
      </div>
      <div className="mt-3 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
        <div>
          <div className="text-xs font-semibold text-muted">Method</div>
          <div className="mt-1 font-mono text-xs text-muted-strong">
            {experience.extractionMethod ?? "unknown"}
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold text-muted">Room</div>
          <div className="mt-1 font-mono text-xs text-muted-strong">
            {shortId(experience.sourceRoomId)}
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold text-muted">Trigger message</div>
          <div className="mt-1 font-mono text-xs text-muted-strong">
            {shortId(experience.sourceTriggerMessageId)}
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold text-muted">Evidence messages</div>
          <div className="mt-1 font-mono text-xs text-muted-strong">
            {sourceMessageIds.length > 0
              ? `${sourceMessageIds.length} captured`
              : "Not recorded"}
          </div>
        </div>
      </div>
      {trajectoryTarget ? (
        <div className="mt-3 text-xs text-muted">
          Trajectory:{" "}
          <a
            href={`/trajectories/${trajectoryTarget}`}
            className="font-mono text-muted-strong underline"
          >
            {shortId(trajectoryTarget)}
          </a>
        </div>
      ) : null}
      {experience.extractionReason ? (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
          {experience.extractionReason}
        </p>
      ) : null}
    </div>
  );
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
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("all");
  const [domainFilter, setDomainFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("priority");

  const selectedExperience = useMemo(
    () => selectedOrFirst(experiences, selectedExperienceId),
    [experiences, selectedExperienceId],
  );
  const [draft, setDraft] = useState<CharacterExperienceDraft>(
    normalizeDraft(selectedExperience),
  );

  const filters = useMemo(() => {
    const outcomes = uniqueSorted(
      experiences.map((experience) => experience.outcome),
    );
    const domains = uniqueSorted(
      experiences.map((experience) => experience.domain),
    );
    const tags = uniqueSorted(
      experiences.flatMap((experience) => experience.tags),
    );
    return { outcomes, domains, tags };
  }, [experiences]);

  const stats = useMemo(() => {
    const total = experiences.length;
    const reviewCount = experiences.filter(needsReview).length;
    const averageImportance =
      total === 0
        ? 0
        : experiences.reduce(
            (sum, experience) => sum + clampScore(experience.importance),
            0,
          ) / total;
    const averageConfidence =
      total === 0
        ? 0
        : experiences.reduce(
            (sum, experience) => sum + clampScore(experience.confidence),
            0,
          ) / total;
    const corrections = experiences.filter(
      (experience) => experience.previousBelief || experience.correctedBelief,
    ).length;
    return {
      averageConfidence,
      averageImportance,
      corrections,
      reviewCount,
      total,
    };
  }, [experiences]);

  const filteredExperiences = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = experiences.filter((experience) => {
      if (outcomeFilter !== "all" && experience.outcome !== outcomeFilter) {
        return false;
      }
      if (domainFilter !== "all" && experience.domain !== domainFilter) {
        return false;
      }
      if (tagFilter !== "all" && !experience.tags.includes(tagFilter)) {
        return false;
      }
      if (reviewFilter === "needs-review" && !needsReview(experience)) {
        return false;
      }
      if (
        reviewFilter === "corrected" &&
        !experience.previousBelief &&
        !experience.correctedBelief
      ) {
        return false;
      }
      if (reviewFilter === "superseded" && !experience.supersedes) {
        return false;
      }
      if (!query) return true;
      const haystack = compactText(
        experience.type,
        experience.outcome,
        experience.domain,
        experience.context,
        experience.action,
        experience.result,
        experience.learning,
        experience.previousBelief,
        experience.correctedBelief,
        experience.supersedes,
        experience.sourceRoomId,
        experience.sourceTriggerMessageId,
        experience.sourceTrajectoryId,
        experience.sourceTrajectoryStepId,
        experience.extractionMethod,
        experience.extractionReason,
        ...(experience.relatedExperienceIds ?? []),
        ...(experience.sourceMessageIds ?? []),
        ...experience.tags,
      );
      return haystack.includes(query);
    });

    return [...filtered].sort((left, right) => {
      switch (sortMode) {
        case "confidence":
          return clampScore(left.confidence) - clampScore(right.confidence);
        case "importance":
          return clampScore(right.importance) - clampScore(left.importance);
        case "newest":
          return (
            getTimestampMs(right.createdAt) - getTimestampMs(left.createdAt)
          );
      }
      return getPriorityScore(right) - getPriorityScore(left);
    });
  }, [
    domainFilter,
    experiences,
    outcomeFilter,
    reviewFilter,
    searchQuery,
    sortMode,
    tagFilter,
  ]);

  const visibleSelectedExperience = useMemo(
    () => selectedOrFirst(filteredExperiences, selectedExperience?.id ?? null),
    [filteredExperiences, selectedExperience?.id],
  );

  useEffect(() => {
    setDraft(normalizeDraft(visibleSelectedExperience));
  }, [visibleSelectedExperience]);
  const selectedRelatedExperiences = useMemo(() => {
    const ids = new Set(visibleSelectedExperience?.relatedExperienceIds ?? []);
    return experiences.filter((experience) => ids.has(experience.id));
  }, [experiences, visibleSelectedExperience?.relatedExperienceIds]);
  const supersededExperience = useMemo(
    () =>
      visibleSelectedExperience?.supersedes
        ? experiences.find(
            (experience) =>
              experience.id === visibleSelectedExperience.supersedes,
          )
        : null,
    [experiences, visibleSelectedExperience],
  );

  if (experiences.length === 0) {
    return (
      <section className="rounded-2xl border border-dashed border-border/40 bg-bg-muted/20 px-5 py-8 text-sm text-muted">
        <div className="text-base font-semibold text-txt">
          I haven&rsquo;t learned anything yet.
        </div>
        <p className="mt-1 max-w-xl">
          As we work together I&rsquo;ll keep notes here — what worked, what
          didn&rsquo;t, things I want to remember next time. Each lesson lands
          with the context that produced it so you can review or correct me.
        </p>
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="rounded-2xl border border-border/40 bg-bg/70 p-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-txt">Experience</h3>
            <p className="text-sm text-muted">
              Triage learned outcomes by priority, confidence, evidence, and
              correction history.
            </p>
          </div>
          <div className="rounded-full border border-border/40 px-3 py-1 text-xs font-semibold text-muted">
            {filteredExperiences.length} of {experiences.length} shown
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <StatTile
            label="Captured"
            value={String(stats.total)}
            detail={`${stats.reviewCount} need review`}
          />
          <StatTile
            label="Avg importance"
            value={formatPercent(stats.averageImportance)}
            detail="Ranking weight"
          />
          <StatTile
            label="Avg confidence"
            value={formatPercent(stats.averageConfidence)}
            detail="Evidence strength"
          />
          <StatTile
            label="Corrections"
            value={String(stats.corrections)}
            detail="Beliefs revised"
          />
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(14rem,1.4fr)_repeat(5,minmax(8rem,1fr))]">
          <label htmlFor="experience-search" className="min-w-0">
            <span className="sr-only">Search experiences</span>
            <Input
              id="experience-search"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("character.searchLearningEvidenceTags")}
              className="h-9 rounded-xl border-border/40 bg-bg-muted/15"
            />
          </label>
          <label className="min-w-0">
            <span className="sr-only">Outcome filter</span>
            <select
              aria-label={t("character.outcomeFilter")}
              value={outcomeFilter}
              onChange={(event) => setOutcomeFilter(event.target.value)}
              className="h-9 w-full rounded-xl border border-border/40 bg-bg-muted/15 px-3 text-sm text-txt"
            >
              <option value="all">All outcomes</option>
              {filters.outcomes.map((outcome) => (
                <option key={outcome} value={outcome}>
                  {outcome}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="sr-only">Domain filter</span>
            <select
              aria-label={t("character.domainFilter")}
              value={domainFilter}
              onChange={(event) => setDomainFilter(event.target.value)}
              className="h-9 w-full rounded-xl border border-border/40 bg-bg-muted/15 px-3 text-sm text-txt"
            >
              <option value="all">All domains</option>
              {filters.domains.map((domain) => (
                <option key={domain} value={domain}>
                  {domain}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="sr-only">Tag filter</span>
            <select
              aria-label={t("character.tagFilter")}
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
              className="h-9 w-full rounded-xl border border-border/40 bg-bg-muted/15 px-3 text-sm text-txt"
            >
              <option value="all">All tags</option>
              {filters.tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="sr-only">Review filter</span>
            <select
              aria-label={t("character.reviewFilter")}
              value={reviewFilter}
              onChange={(event) =>
                setReviewFilter(event.target.value as ReviewFilter)
              }
              className="h-9 w-full rounded-xl border border-border/40 bg-bg-muted/15 px-3 text-sm text-txt"
            >
              <option value="all">All review states</option>
              <option value="needs-review">Needs review</option>
              <option value="corrected">Corrected belief</option>
              <option value="superseded">Supersedes prior</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="sr-only">Sort experiences</span>
            <select
              aria-label={t("character.sortExperiences")}
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              className="h-9 w-full rounded-xl border border-border/40 bg-bg-muted/15 px-3 text-sm text-txt"
            >
              <option value="priority">Priority</option>
              <option value="newest">Newest</option>
              <option value="importance">Importance</option>
              <option value="confidence">Lowest confidence</option>
            </select>
          </label>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(19rem,25rem)_minmax(0,1fr)]">
        <div className="flex min-h-[28rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-bg/70">
          <div className="border-b border-border/30 px-4 py-3">
            <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
              Review queue
            </div>
            <p className="mt-1 text-sm text-muted">
              Priority favors high importance, low confidence, and corrected
              beliefs.
            </p>
          </div>
          <div className="custom-scrollbar flex min-w-0 flex-1 flex-col overflow-y-auto">
            {filteredExperiences.length === 0 ? (
              <div className="px-4 py-8 text-sm text-muted">
                No experiences match the current filters.
              </div>
            ) : (
              filteredExperiences.map((experience) => {
                const isSelected =
                  experience.id === visibleSelectedExperience?.id;
                const reviewReasons = [
                  clampScore(experience.importance) >= 0.75
                    ? "high importance"
                    : null,
                  clampScore(experience.confidence) < 0.65
                    ? "low confidence"
                    : null,
                  experience.previousBelief || experience.correctedBelief
                    ? "belief changed"
                    : null,
                ].filter(Boolean);
                return (
                  <button
                    key={experience.id}
                    type="button"
                    data-testid={`experience-row-${experience.id}`}
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
                      {needsReview(experience) ? (
                        <span className="rounded-full border border-status-warning/30 bg-status-warning-bg px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-status-warning">
                          Review
                        </span>
                      ) : null}
                    </div>
                    <h4 className="line-clamp-2 text-sm font-semibold text-txt">
                      {experience.learning ||
                        experience.result ||
                        experience.context}
                    </h4>
                    <div className="grid w-full grid-cols-2 gap-2 text-xs text-muted">
                      <span>
                        Importance {formatPercent(experience.importance)}
                      </span>
                      <span>
                        Confidence {formatPercent(experience.confidence)}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-sm text-muted-strong">
                      {experience.context}
                    </p>
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
                      <span>{formatTimestamp(experience.createdAt)}</span>
                      {experience.domain ? (
                        <span>{experience.domain}</span>
                      ) : null}
                      {reviewReasons.length > 0 ? (
                        <span>{reviewReasons.join(", ")}</span>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {visibleSelectedExperience ? (
          <div className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border/40 bg-bg/70 px-4 py-4">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="rounded-full border border-border/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    {visibleSelectedExperience.type}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] ${outcomeAccent(visibleSelectedExperience.outcome)}`}
                  >
                    {visibleSelectedExperience.outcome}
                  </span>
                  {visibleSelectedExperience.domain ? (
                    <span className="rounded-full border border-border/40 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                      {visibleSelectedExperience.domain}
                    </span>
                  ) : null}
                  {needsReview(visibleSelectedExperience) ? (
                    <span className="rounded-full border border-status-warning/30 bg-status-warning-bg px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-status-warning">
                      Needs review
                    </span>
                  ) : null}
                </div>
                <h4 className="mt-2 text-lg font-semibold leading-snug text-txt">
                  {visibleSelectedExperience.learning ||
                    visibleSelectedExperience.result ||
                    visibleSelectedExperience.context}
                </h4>
                <p className="mt-1 text-xs text-muted">
                  Created {formatTimestamp(visibleSelectedExperience.createdAt)}
                  {visibleSelectedExperience.updatedAt
                    ? ` · Updated ${formatTimestamp(visibleSelectedExperience.updatedAt)}`
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
                    disabled={
                      deletingExperienceId === visibleSelectedExperience.id
                    }
                    onClick={() =>
                      onDeleteExperience(visibleSelectedExperience)
                    }
                  >
                    {deletingExperienceId === visibleSelectedExperience.id
                      ? "Deleting..."
                      : "Delete"}
                  </Button>
                ) : null}
                {onSaveExperience ? (
                  <Button
                    type="button"
                    size="sm"
                    className="rounded-lg"
                    disabled={
                      savingExperienceId === visibleSelectedExperience.id
                    }
                    onClick={() =>
                      onSaveExperience(visibleSelectedExperience, draft)
                    }
                  >
                    {savingExperienceId === visibleSelectedExperience.id
                      ? "Saving..."
                      : "Save review"}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]">
              <div className="space-y-4">
                <div className="rounded-xl border border-border/30 bg-bg-muted/15 p-3">
                  <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    Learned takeaway
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
                    {visibleSelectedExperience.learning || "Not recorded."}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <EvidencePanel
                    title="Context"
                    body={visibleSelectedExperience.context}
                  />
                  <EvidencePanel
                    title="Action"
                    body={visibleSelectedExperience.action}
                  />
                  <EvidencePanel
                    title="Result"
                    body={visibleSelectedExperience.result}
                  />
                </div>
              </div>

              <div className="space-y-4 rounded-xl border border-border/30 bg-bg-muted/10 p-3">
                <ScoreBar
                  label="Importance"
                  value={visibleSelectedExperience.importance}
                  explanation="Higher values rank this learning as more likely to affect future behavior."
                />
                <ScoreBar
                  label="Confidence"
                  value={visibleSelectedExperience.confidence}
                  explanation="Lower confidence keeps this item in the review queue until evidence improves."
                />
                <div>
                  <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    Tags
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {visibleSelectedExperience.tags.length > 0 ? (
                      visibleSelectedExperience.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-border/40 px-2 py-0.5 text-xs text-muted-strong"
                        >
                          {tag}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-muted">
                        No tags recorded.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <EvidencePanel
                title="Previous belief"
                body={visibleSelectedExperience.previousBelief}
              />
              <EvidencePanel
                title="Corrected belief"
                body={visibleSelectedExperience.correctedBelief}
              />
            </div>

            {visibleSelectedExperience.supersedes ||
            selectedRelatedExperiences.length > 0 ? (
              <div className="rounded-xl border border-border/30 bg-bg-muted/15 p-3">
                <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                  Related experience trail
                </div>
                <div className="mt-2 space-y-2 text-sm text-muted-strong">
                  {visibleSelectedExperience.supersedes ? (
                    <p>
                      Supersedes{" "}
                      <span className="font-mono text-txt">
                        {visibleSelectedExperience.supersedes}
                      </span>
                      {supersededExperience
                        ? `: ${supersededExperience.learning || supersededExperience.result}`
                        : ""}
                    </p>
                  ) : null}
                  {selectedRelatedExperiences.map((experience) => (
                    <button
                      key={experience.id}
                      type="button"
                      className="block w-full rounded-lg border border-border/30 px-3 py-2 text-left hover:bg-bg-muted/20"
                      onClick={() => onSelectExperience(experience.id)}
                    >
                      <span className="font-mono text-xs text-muted">
                        {experience.id}
                      </span>
                      <span className="ml-2">
                        {experience.learning ||
                          experience.result ||
                          experience.context}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <ProvenancePanel experience={visibleSelectedExperience} />

            <div className="rounded-xl border border-border/30 bg-bg-muted/10 p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    Review edit
                  </div>
                  <p className="text-xs text-muted">
                    Update the takeaway, ranking, and tags after checking
                    evidence.
                  </p>
                </div>
              </div>

              <label
                htmlFor={`experience-learning-${visibleSelectedExperience.id}`}
                className="flex min-w-0 flex-col gap-2"
              >
                <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                  Learning
                </span>
                <Textarea
                  id={`experience-learning-${visibleSelectedExperience.id}`}
                  value={draft.learning}
                  rows={6}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      learning: event.target.value,
                    }))
                  }
                  className="min-h-[8rem] resize-y rounded-xl border-border/40 bg-bg-muted/15 font-mono text-sm leading-relaxed"
                />
              </label>

              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <label
                  htmlFor={`experience-importance-${visibleSelectedExperience.id}`}
                  className="flex min-w-0 flex-col gap-2"
                >
                  <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    Importance
                  </span>
                  <Input
                    id={`experience-importance-${visibleSelectedExperience.id}`}
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
                  htmlFor={`experience-confidence-${visibleSelectedExperience.id}`}
                  className="flex min-w-0 flex-col gap-2"
                >
                  <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    Confidence
                  </span>
                  <Input
                    id={`experience-confidence-${visibleSelectedExperience.id}`}
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
                  htmlFor={`experience-tags-${visibleSelectedExperience.id}`}
                  className="flex min-w-0 flex-col gap-2"
                >
                  <span className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    Tags
                  </span>
                  <Input
                    id={`experience-tags-${visibleSelectedExperience.id}`}
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
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
