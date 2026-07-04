/**
 * Master/detail editor for the agent's learned experiences, driving both the
 * promoted top-level Experience view and the experience section of the
 * character hub. Renders the review-status filter, the experience list, and the
 * editable draft pane; it is fully controlled — the parent owns the records and
 * the save/delete/select callbacks (and the save/delete-in-flight ids). Pass
 * `showTitle={false}` when the host view already supplies a ViewHeader.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type {
  CharacterExperienceDraft,
  CharacterExperienceRecord,
} from "./character-hub-types";

type ReviewFilter = "all" | "needs-review" | "corrected" | "superseded";

const REVIEW_FILTERS: ReadonlyArray<{ value: ReviewFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "needs-review", label: "Needs review" },
  { value: "corrected", label: "Corrected" },
  { value: "superseded", label: "Supersedes" },
];

type LocalExperienceGraphLink = {
  sourceId: string;
  targetId: string;
  type: "similar" | "supersedes";
  strength: number;
  keywords: string[];
};

// Per-relationship-type display weights (drive stroke width / sort order).
// Not data magnitudes — `supersedes` is drawn heavier than `similar`.
const LINK_DISPLAY_WEIGHT: Record<LocalExperienceGraphLink["type"], number> = {
  supersedes: 0.95,
  similar: 0.7,
};
type GraphPosition = {
  x: number;
  y: number;
};

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

// One signal: a single dot whose color carries outcome (or turns orange when an
// item needs review). No badge stacks.
function outcomeDotColor(outcome: string): string {
  switch (outcome) {
    case "positive":
      return "var(--status-success)";
    case "negative":
      return "var(--status-danger)";
    case "mixed":
      return "var(--status-warning)";
    default:
      return "var(--muted)";
  }
}

function OutcomeDot({ outcome, review }: { outcome: string; review: boolean }) {
  const color = review ? "var(--status-warning)" : outcomeDotColor(outcome);
  return (
    <span
      aria-hidden="true"
      className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}

function clampScore(value: number | null | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatPercent(value: number | null | undefined): string {
  return `${Math.round(clampScore(value) * 100)}%`;
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

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]),
  ).sort((left, right) => left.localeCompare(right));
}

function shortId(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

function experienceKeywords(experience: CharacterExperienceRecord): string[] {
  return experience.keywords && experience.keywords.length > 0
    ? experience.keywords
    : experience.tags;
}

function sharedValues(left: string[], right: string[]): string[] {
  const rightValues = new Set(right);
  return left.filter((value) => rightValues.has(value));
}

function buildLocalGraphLinks(
  experiences: CharacterExperienceRecord[],
): LocalExperienceGraphLink[] {
  const links = new Map<string, LocalExperienceGraphLink>();
  const addLink = (link: LocalExperienceGraphLink) => {
    const key = `${link.sourceId}:${link.targetId}:${link.type}`;
    const existing = links.get(key);
    if (!existing || existing.strength < link.strength) {
      links.set(key, link);
    }
  };
  const byId = new Map(
    experiences.map((experience) => [experience.id, experience]),
  );

  // Only render edges backed by relationships the server actually recorded
  // (`supersedes` and `relatedExperienceIds`). `strength` is a type-derived
  // display weight for stroke width, not a fabricated per-edge data value.
  for (const experience of experiences) {
    const supersededExperience = experience.supersedes
      ? byId.get(experience.supersedes)
      : undefined;
    if (experience.supersedes && supersededExperience) {
      addLink({
        sourceId: experience.id,
        targetId: experience.supersedes,
        type: "supersedes",
        strength: LINK_DISPLAY_WEIGHT.supersedes,
        keywords: sharedValues(
          experienceKeywords(experience),
          experienceKeywords(supersededExperience),
        ),
      });
    }
    for (const relatedId of experience.relatedExperienceIds ?? []) {
      const relatedExperience = byId.get(relatedId);
      if (relatedExperience) {
        addLink({
          sourceId: experience.id,
          targetId: relatedId,
          type: "similar",
          strength: LINK_DISPLAY_WEIGHT.similar,
          keywords: sharedValues(
            experienceKeywords(experience),
            experienceKeywords(relatedExperience),
          ),
        });
      }
    }
  }

  return Array.from(links.values())
    .sort((left, right) => right.strength - left.strength)
    .slice(0, 60);
}

function buildGraphPositions(
  experiences: CharacterExperienceRecord[],
): Map<string, GraphPosition> {
  const domains = uniqueSorted(
    experiences.map((experience) => experience.domain),
  );
  const domainCenter = new Map(
    domains.map((domain, index) => {
      const total = Math.max(domains.length, 1);
      const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
      return [
        domain ?? "general",
        {
          x: 50 + Math.cos(angle) * 24,
          y: 50 + Math.sin(angle) * 22,
        },
      ];
    }),
  );
  const domainCounts = new Map<string, number>();

  return new Map(
    experiences.map((experience, index) => {
      const domain = experience.domain ?? "general";
      const domainIndex = domainCounts.get(domain) ?? 0;
      domainCounts.set(domain, domainIndex + 1);
      const center = domainCenter.get(domain) ?? { x: 50, y: 50 };
      const angle = (Math.PI * 2 * domainIndex) / 7 + index * 0.41;
      const radius = 5 + (domainIndex % 4) * 4.8;
      return [
        experience.id,
        {
          x: Math.max(8, Math.min(92, center.x + Math.cos(angle) * radius)),
          y: Math.max(10, Math.min(90, center.y + Math.sin(angle) * radius)),
        },
      ];
    }),
  );
}

// Outcome maps to a single status-token color; state is carried by the fill, not
// by decorative glow/ring layers.
function graphNodeColor(experience: CharacterExperienceRecord): string {
  switch (experience.outcome) {
    case "positive":
      return "var(--status-success)";
    case "negative":
      return "var(--status-danger)";
    case "mixed":
      return "var(--status-warning)";
    default:
      return "var(--muted)";
  }
}

function graphLinkColor(type: LocalExperienceGraphLink["type"]): string {
  return type === "supersedes" ? "var(--status-warning)" : "var(--border)";
}

function graphPath(source: GraphPosition, target: GraphPosition): string {
  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const curve = Math.min(10, Math.max(-10, (dx - dy) * 0.12));
  return `M ${source.x} ${source.y} Q ${midX + curve} ${midY - curve} ${target.x} ${target.y}`;
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
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold leading-tight text-txt">
        {value}
      </div>
      <div className="mt-0.5 truncate text-xs text-muted">{detail}</div>
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
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
    <div className="min-w-0">
      <div className="text-xs text-muted">{title}</div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
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
    <div className="min-w-0">
      <div className="text-xs text-muted">Evidence source</div>
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
          <div className="text-xs font-semibold text-muted">
            Trigger message
          </div>
          <div className="mt-1 font-mono text-xs text-muted-strong">
            {shortId(experience.sourceTriggerMessageId)}
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold text-muted">
            Evidence messages
          </div>
          <div className="mt-1 font-mono text-xs text-muted-strong">
            {sourceMessageIds.length > 0
              ? `${sourceMessageIds.length} captured`
              : "Not recorded"}
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold text-muted">
            Associated entities
          </div>
          <div className="mt-1 font-mono text-xs text-muted-strong">
            {(experience.associatedEntityIds ?? []).length > 0
              ? `${experience.associatedEntityIds?.length} linked`
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

function ExperienceGraphNode({
  experience,
  position,
  selected,
  connected,
  onSelectExperience,
}: {
  experience: CharacterExperienceRecord;
  position: GraphPosition;
  selected: boolean;
  connected: boolean;
  onSelectExperience: (experienceId: string) => void;
}) {
  const review = needsReview(experience);
  const color = review ? "var(--status-warning)" : graphNodeColor(experience);
  const size = 1.9 + clampScore(experience.importance) * 2.7;
  const confidence = clampScore(experience.confidence);
  const nodeLabel =
    experience.learning || experience.result || experience.context;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `experience-node-${experience.id}`,
    role: "list-item",
    label: `Experience node: ${nodeLabel}`,
    group: "experience-graph",
    status: selected ? "active" : undefined,
    description: "Select this experience from the knowledge graph",
    onActivate: () => onSelectExperience(experience.id),
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      aria-label={`Select experience: ${nodeLabel}`}
      data-testid={`experience-graph-node-${experience.id}`}
      className="absolute h-auto -translate-x-1/2 -translate-y-1/2 rounded-full p-0 outline-none transition duration-200 hover:scale-125"
      style={{
        left: `${position.x}%`,
        top: `${position.y}%`,
        width: `${size}rem`,
        height: `${size}rem`,
      }}
      onClick={() => onSelectExperience(experience.id)}
      {...agentProps}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full"
        style={{
          background: color,
          opacity: 0.45 + confidence * 0.45,
          outline: selected
            ? "2px solid var(--accent)"
            : connected
              ? "1px solid var(--border)"
              : "none",
          outlineOffset: "2px",
        }}
      />
    </Button>
  );
}

const ExperienceGraphPanel = memo(function ExperienceGraphPanel({
  experiences,
  selectedExperienceId,
  onSelectExperience,
}: {
  experiences: CharacterExperienceRecord[];
  selectedExperienceId: string | null;
  onSelectExperience: (experienceId: string) => void;
}) {
  const graphExperiences = useMemo(
    () => experiences.slice(0, 24),
    [experiences],
  );
  const links = useMemo(
    () => buildLocalGraphLinks(graphExperiences),
    [graphExperiences],
  );
  const positions = useMemo(
    () => buildGraphPositions(graphExperiences),
    [graphExperiences],
  );
  const connectedIds = useMemo(
    () => new Set(links.flatMap((link) => [link.sourceId, link.targetId])),
    [links],
  );

  return (
    <div
      data-testid="experience-graph-panel"
      /* bg kept: functional canvas bounds for the clickable graph nodes, not card chrome */
      className="relative h-[24rem] overflow-hidden rounded-sm bg-bg-muted/20"
    >
      <svg
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {links.map((link) => {
          const source = positions.get(link.sourceId);
          const target = positions.get(link.targetId);
          if (!source || !target) return null;
          return (
            <path
              key={`${link.sourceId}-${link.targetId}-${link.type}`}
              d={graphPath(source, target)}
              fill="none"
              stroke={graphLinkColor(link.type)}
              strokeDasharray={link.type === "supersedes" ? "3 3" : undefined}
              strokeLinecap="round"
              strokeWidth={Math.max(0.22, link.strength * 0.8)}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      {graphExperiences.map((experience) => (
        <ExperienceGraphNode
          key={experience.id}
          experience={experience}
          position={positions.get(experience.id) ?? { x: 50, y: 50 }}
          selected={experience.id === selectedExperienceId}
          connected={connectedIds.has(experience.id)}
          onSelectExperience={onSelectExperience}
        />
      ))}
    </div>
  );
});

const ExperienceQueueRow = memo(function ExperienceQueueRow({
  experience,
  isSelected,
  onSelect,
}: {
  experience: CharacterExperienceRecord;
  isSelected: boolean;
  onSelect: (experienceId: string) => void;
}) {
  const title = experience.learning || experience.result || experience.context;
  const reviewReasons = [
    clampScore(experience.importance) >= 0.75 ? "high importance" : null,
    clampScore(experience.confidence) < 0.65 ? "low confidence" : null,
    experience.previousBelief || experience.correctedBelief
      ? "belief changed"
      : null,
  ].filter(Boolean);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `experience-row-${experience.id}`,
    role: "list-item",
    label: `Experience: ${title}`,
    group: "experience-queue",
    status: isSelected ? "active" : undefined,
    description: "Open this experience in the review panel",
    onActivate: () => onSelect(experience.id),
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      data-testid={`experience-row-${experience.id}`}
      className={`h-auto w-full min-w-0 flex-col items-start justify-start gap-2 rounded-none px-4 py-4 text-left font-normal transition-colors hover:bg-bg-muted/20 ${isSelected ? "bg-bg-muted/25" : ""}`}
      onClick={() => onSelect(experience.id)}
      {...agentProps}
    >
      <div className="flex min-w-0 items-start gap-2">
        <OutcomeDot
          outcome={experience.outcome}
          review={needsReview(experience)}
        />
        <h4 className="line-clamp-2 text-sm font-semibold text-txt">{title}</h4>
      </div>
      <div className="grid w-full grid-cols-2 gap-2 text-xs text-muted">
        <span>Importance {formatPercent(experience.importance)}</span>
        <span>Confidence {formatPercent(experience.confidence)}</span>
      </div>
      <p className="line-clamp-2 text-sm text-muted-strong">
        {experience.context}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
        <span>{experience.type}</span>
        {experience.domain ? <span>· {experience.domain}</span> : null}
        <span>· {formatTimestamp(experience.createdAt)}</span>
        {reviewReasons.length > 0 ? (
          <span>· {reviewReasons.join(", ")}</span>
        ) : null}
      </div>
    </Button>
  );
});

function RelatedExperienceButton({
  experience,
  onSelect,
}: {
  experience: CharacterExperienceRecord;
  onSelect: (experienceId: string) => void;
}) {
  const title = experience.learning || experience.result || experience.context;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `experience-related-${experience.id}`,
    role: "list-item",
    label: `Related experience: ${title}`,
    group: "experience-related",
    description: "Open this related experience",
    onActivate: () => onSelect(experience.id),
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      className="h-auto w-full justify-start rounded-sm px-3 py-2 text-left font-normal hover:bg-bg-muted/20"
      onClick={() => onSelect(experience.id)}
      {...agentProps}
    >
      <span className="font-mono text-xs text-muted">{experience.id}</span>
      <span className="ml-2">{title}</span>
    </Button>
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
  showTitle = true,
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
  /** Hide the in-body "Experience" heading when the host view already renders
   *  a ViewHeader with the same title (the promoted top-level view). */
  showTitle?: boolean;
}) {
  const { t } = useTranslation();
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");

  const selectedExperience = useMemo(
    () => selectedOrFirst(experiences, selectedExperienceId),
    [experiences, selectedExperienceId],
  );
  const [draft, setDraft] = useState<CharacterExperienceDraft>(
    normalizeDraft(selectedExperience),
  );

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
    const filtered = experiences.filter((experience) => {
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
      return true;
    });

    return [...filtered].sort(
      (left, right) => getPriorityScore(right) - getPriorityScore(left),
    );
  }, [experiences, reviewFilter]);

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

  const { ref: reviewRef, agentProps: reviewAgentProps } =
    useAgentElement<HTMLDivElement>({
      id: "experience-filter-review",
      role: "select",
      label: t("character.reviewFilter"),
      group: "experience-filters",
      description: "Filter experiences by review state",
      options: ["all", "needs-review", "corrected", "superseded"],
      getValue: () => reviewFilter,
      onFill: (value) => setReviewFilter(value as ReviewFilter),
    });
  const { ref: deleteRef, agentProps: deleteAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "experience-delete",
      role: "button",
      label: "Delete experience",
      group: "experience-review",
      description: "Delete the selected experience",
      onActivate: () => {
        if (visibleSelectedExperience) {
          onDeleteExperience?.(visibleSelectedExperience);
        }
      },
    });
  const { ref: saveRef, agentProps: saveAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "experience-save",
      role: "button",
      label: "Save review",
      group: "experience-review",
      description: "Save the review edits for the selected experience",
      onActivate: () => {
        if (visibleSelectedExperience) {
          onSaveExperience?.(visibleSelectedExperience, draft);
        }
      },
    });
  const { ref: learningRef, agentProps: learningAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "experience-edit-learning",
      role: "textarea",
      label: "Learning",
      group: "experience-review",
      description: "Edit the learned takeaway for this experience",
      getValue: () => draft.learning,
      onFill: (value) =>
        setDraft((current) => ({ ...current, learning: value })),
    });
  const { ref: importanceRef, agentProps: importanceAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "experience-edit-importance",
      role: "number-input",
      label: "Importance",
      group: "experience-review",
      description: "Edit the importance score (0 to 1)",
      getValue: () => draft.importance,
      onFill: (value) =>
        setDraft((current) => ({
          ...current,
          importance: Number(value || 0),
        })),
    });
  const { ref: confidenceRef, agentProps: confidenceAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "experience-edit-confidence",
      role: "number-input",
      label: "Confidence",
      group: "experience-review",
      description: "Edit the confidence score (0 to 1)",
      getValue: () => draft.confidence,
      onFill: (value) =>
        setDraft((current) => ({
          ...current,
          confidence: Number(value || 0),
        })),
    });
  const { ref: tagsRef, agentProps: tagsAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "experience-edit-tags",
      role: "text-input",
      label: "Tags",
      group: "experience-review",
      description: "Edit the comma-separated tags for this experience",
      getValue: () => draft.tags,
      onFill: (value) => setDraft((current) => ({ ...current, tags: value })),
    });

  if (experiences.length === 0) {
    return (
      /* Flat — no card/border. The shell owns the page's horizontal padding. */
      <section className="py-8 text-sm text-muted">
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
    /* Flat — no card/border. The shell owns the page's horizontal padding. */
    <section className="flex min-w-0 flex-col gap-4">
      <div>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          {showTitle ? (
            <h3 className="text-base font-semibold text-txt">Experience</h3>
          ) : null}
          <div className="ml-auto text-xs font-medium text-muted">
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

        <div
          ref={reviewRef}
          className="mt-4 flex flex-wrap gap-1"
          {...reviewAgentProps}
        >
          {REVIEW_FILTERS.map((option) => (
            <Button
              key={option.value}
              variant="ghost"
              size="sm"
              onClick={() => setReviewFilter(option.value)}
              className={`h-8 rounded-full px-3 text-xs font-medium transition-colors ${
                reviewFilter === option.value
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-bg-muted/30 hover:text-txt"
              }`}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <ExperienceGraphPanel
        experiences={filteredExperiences}
        selectedExperienceId={visibleSelectedExperience?.id ?? null}
        onSelectExperience={onSelectExperience}
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(19rem,25rem)_minmax(0,1fr)]">
        <div className="flex min-h-[28rem] min-w-0 flex-col overflow-hidden">
          <div className="px-4 py-3">
            <div className="text-sm font-semibold text-txt">Review queue</div>
          </div>
          <div className="custom-scrollbar flex min-w-0 flex-1 flex-col overflow-y-auto">
            {filteredExperiences.length === 0 ? (
              <div className="px-4 py-8 text-sm text-muted">
                No experiences match the current filters.
              </div>
            ) : (
              filteredExperiences.map((experience) => (
                <ExperienceQueueRow
                  key={experience.id}
                  experience={experience}
                  isSelected={experience.id === visibleSelectedExperience?.id}
                  onSelect={onSelectExperience}
                />
              ))
            )}
          </div>
        </div>

        {visibleSelectedExperience ? (
          <div className="flex min-w-0 flex-col gap-4 px-4 py-4">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start gap-2">
                  <OutcomeDot
                    outcome={visibleSelectedExperience.outcome}
                    review={needsReview(visibleSelectedExperience)}
                  />
                  <h4 className="text-lg font-semibold leading-snug text-txt">
                    {visibleSelectedExperience.learning ||
                      visibleSelectedExperience.result ||
                      visibleSelectedExperience.context}
                  </h4>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {visibleSelectedExperience.type}
                  {visibleSelectedExperience.domain
                    ? ` · ${visibleSelectedExperience.domain}`
                    : ""}
                  {` · Created ${formatTimestamp(visibleSelectedExperience.createdAt)}`}
                  {visibleSelectedExperience.updatedAt
                    ? ` · Updated ${formatTimestamp(visibleSelectedExperience.updatedAt)}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {onDeleteExperience ? (
                  <Button
                    ref={deleteRef}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-sm"
                    disabled={
                      deletingExperienceId === visibleSelectedExperience.id
                    }
                    onClick={() =>
                      onDeleteExperience(visibleSelectedExperience)
                    }
                    {...deleteAgentProps}
                  >
                    {deletingExperienceId === visibleSelectedExperience.id
                      ? "Deleting..."
                      : "Delete"}
                  </Button>
                ) : null}
                {onSaveExperience ? (
                  <Button
                    ref={saveRef}
                    type="button"
                    size="sm"
                    className="rounded-sm"
                    disabled={
                      savingExperienceId === visibleSelectedExperience.id
                    }
                    onClick={() =>
                      onSaveExperience(visibleSelectedExperience, draft)
                    }
                    {...saveAgentProps}
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
                <div className="min-w-0">
                  <div className="text-xs text-muted">Learned takeaway</div>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-muted-strong">
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

              <div className="space-y-4 lg:pl-4">
                <ScoreBar
                  label="Importance"
                  value={visibleSelectedExperience.importance}
                />
                <ScoreBar
                  label="Confidence"
                  value={visibleSelectedExperience.confidence}
                />
                <div>
                  <div className="text-xs text-muted">Tags</div>
                  {visibleSelectedExperience.tags.length > 0 ? (
                    <p className="mt-2 text-sm text-muted-strong">
                      {visibleSelectedExperience.tags.join(" · ")}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-muted">No tags recorded.</p>
                  )}
                </div>
                <div>
                  <div className="text-xs text-muted">Keywords</div>
                  {experienceKeywords(visibleSelectedExperience).length > 0 ? (
                    <p className="mt-2 text-sm text-muted-strong">
                      {experienceKeywords(visibleSelectedExperience).join(
                        " · ",
                      )}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-muted">
                      No keywords recorded.
                    </p>
                  )}
                </div>
                <div>
                  <div className="text-xs text-muted">Graph metadata</div>
                  <p className="mt-2 text-sm text-muted-strong">
                    {
                      (visibleSelectedExperience.associatedEntityIds ?? [])
                        .length
                    }{" "}
                    associated entities ·{" "}
                    {visibleSelectedExperience.embeddingDimensions ?? 0}{" "}
                    embedding dimensions
                  </p>
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
              <div className="min-w-0">
                <div className="text-xs text-muted">
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
                    <RelatedExperienceButton
                      key={experience.id}
                      experience={experience}
                      onSelect={onSelectExperience}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            <ProvenancePanel experience={visibleSelectedExperience} />

            <div className="min-w-0 pt-4">
              <div className="mb-3 text-sm font-semibold text-txt">
                Review edit
              </div>

              <label
                htmlFor={`experience-learning-${visibleSelectedExperience.id}`}
                className="flex min-w-0 flex-col gap-2"
              >
                <span className="text-xs text-muted">Learning</span>
                <Textarea
                  ref={learningRef}
                  id={`experience-learning-${visibleSelectedExperience.id}`}
                  value={draft.learning}
                  rows={6}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      learning: event.target.value,
                    }))
                  }
                  className="min-h-[8rem] resize-y rounded-none border-0 border-b border-border/40 bg-transparent px-0 font-mono text-sm leading-relaxed"
                  {...learningAgentProps}
                />
              </label>

              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <label
                  htmlFor={`experience-importance-${visibleSelectedExperience.id}`}
                  className="flex min-w-0 flex-col gap-2"
                >
                  <span className="text-xs text-muted">Importance</span>
                  <Input
                    ref={importanceRef}
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
                    className="rounded-none border-0 border-b border-border/40 bg-transparent px-0"
                    {...importanceAgentProps}
                  />
                </label>
                <label
                  htmlFor={`experience-confidence-${visibleSelectedExperience.id}`}
                  className="flex min-w-0 flex-col gap-2"
                >
                  <span className="text-xs text-muted">Confidence</span>
                  <Input
                    ref={confidenceRef}
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
                    className="rounded-none border-0 border-b border-border/40 bg-transparent px-0"
                    {...confidenceAgentProps}
                  />
                </label>
                <label
                  htmlFor={`experience-tags-${visibleSelectedExperience.id}`}
                  className="flex min-w-0 flex-col gap-2"
                >
                  <span className="text-xs text-muted">Tags</span>
                  <Input
                    ref={tagsRef}
                    id={`experience-tags-${visibleSelectedExperience.id}`}
                    type="text"
                    value={draft.tags}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        tags: event.target.value,
                      }))
                    }
                    className="rounded-none border-0 border-b border-border/40 bg-transparent px-0"
                    {...tagsAgentProps}
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
