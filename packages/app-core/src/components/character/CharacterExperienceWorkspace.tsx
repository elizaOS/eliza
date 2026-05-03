import { Button, Input, Textarea } from "@elizaos/ui";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../state/TranslationContext";
import type {
  CharacterExperienceDraft,
  CharacterExperienceRecord,
} from "./character-hub-types";

type ReviewFilter = "all" | "needs-review" | "corrected" | "superseded";
type SortMode = "priority" | "newest" | "confidence" | "importance";
type LocalExperienceGraphLink = {
  sourceId: string;
  targetId: string;
  type: "similar" | "supports" | "supersedes" | "co_occurs";
  strength: number;
  keywords: string[];
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

  for (const experience of experiences) {
    const supersededExperience = experience.supersedes
      ? byId.get(experience.supersedes)
      : undefined;
    if (experience.supersedes && supersededExperience) {
      addLink({
        sourceId: experience.id,
        targetId: experience.supersedes,
        type: "supersedes",
        strength: 0.95,
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
          strength: 0.7,
          keywords: sharedValues(
            experienceKeywords(experience),
            experienceKeywords(relatedExperience),
          ),
        });
      }
    }
  }

  for (let index = 0; index < experiences.length; index++) {
    const left = experiences[index];
    if (!left) continue;
    for (
      let nextIndex = index + 1;
      nextIndex < experiences.length;
      nextIndex++
    ) {
      const right = experiences[nextIndex];
      if (!right) continue;
      const keywords = sharedValues(
        experienceKeywords(left),
        experienceKeywords(right),
      );
      const sharedEntity = (left.associatedEntityIds ?? []).some((entityId) =>
        (right.associatedEntityIds ?? []).includes(entityId),
      );
      if (keywords.length >= 2 && left.domain === right.domain) {
        addLink({
          sourceId: left.id,
          targetId: right.id,
          type: "supports",
          strength: Math.min(0.85, 0.4 + keywords.length * 0.1),
          keywords,
        });
      } else if (sharedEntity && left.domain === right.domain) {
        addLink({
          sourceId: left.id,
          targetId: right.id,
          type: "co_occurs",
          strength: 0.55,
          keywords,
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

function graphNodeColor(experience: CharacterExperienceRecord): {
  fill: string;
  glow: string;
  ring: string;
} {
  switch (experience.outcome) {
    case "positive":
      return {
        fill: "rgb(34 197 94)",
        glow: "rgba(34,197,94,0.42)",
        ring: "rgba(134,239,172,0.9)",
      };
    case "negative":
      return {
        fill: "rgb(239 68 68)",
        glow: "rgba(239,68,68,0.42)",
        ring: "rgba(252,165,165,0.9)",
      };
    case "mixed":
      return {
        fill: "rgb(245 158 11)",
        glow: "rgba(245,158,11,0.42)",
        ring: "rgba(253,230,138,0.9)",
      };
    default:
      return {
        fill: "rgb(56 189 248)",
        glow: "rgba(56,189,248,0.38)",
        ring: "rgba(125,211,252,0.85)",
      };
  }
}

function graphLinkColor(type: LocalExperienceGraphLink["type"]): string {
  switch (type) {
    case "supersedes":
      return "rgba(245,158,11,0.9)";
    case "co_occurs":
      return "rgba(56,189,248,0.72)";
    case "supports":
      return "rgba(34,197,94,0.64)";
    default:
      return "rgba(148,163,184,0.56)";
  }
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

function ExperienceGraphPanel({
  experiences,
  selectedExperienceId,
  onSelectExperience,
}: {
  experiences: CharacterExperienceRecord[];
  selectedExperienceId: string | null;
  onSelectExperience: (experienceId: string) => void;
}) {
  const graphExperiences = experiences.slice(0, 24);
  const links = buildLocalGraphLinks(graphExperiences);
  const positions = buildGraphPositions(graphExperiences);
  const connectedIds = new Set(
    links.flatMap((link) => [link.sourceId, link.targetId]),
  );

  return (
    <div
      data-testid="experience-graph-panel"
      className="relative h-[24rem] overflow-hidden rounded-[2rem] border border-border/40 bg-[radial-gradient(circle_at_18%_16%,rgba(56,189,248,0.18),transparent_30%),radial-gradient(circle_at_82%_24%,rgba(245,158,11,0.16),transparent_28%),radial-gradient(circle_at_50%_92%,rgba(34,197,94,0.12),transparent_34%),linear-gradient(135deg,rgba(15,23,42,0.24),rgba(2,6,23,0.04))]"
    >
      <div className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.08)_1px,transparent_1px)] [background-size:34px_34px]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(2,6,23,0.22)_72%)]" />
      <svg
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <defs>
          <filter
            id="experience-graph-glow"
            x="-60%"
            y="-60%"
            width="220%"
            height="220%"
          >
            <feGaussianBlur stdDeviation="1.7" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {links.map((link) => {
          const source = positions.get(link.sourceId);
          const target = positions.get(link.targetId);
          if (!source || !target) return null;
          return (
            <path
              key={`${link.sourceId}-${link.targetId}-${link.type}`}
              d={graphPath(source, target)}
              fill="none"
              filter="url(#experience-graph-glow)"
              stroke={graphLinkColor(link.type)}
              strokeDasharray={link.type === "supersedes" ? "3 3" : undefined}
              strokeLinecap="round"
              strokeWidth={Math.max(0.22, link.strength * 0.8)}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      {graphExperiences.map((experience) => {
        const position = positions.get(experience.id) ?? { x: 50, y: 50 };
        const selected = experience.id === selectedExperienceId;
        const review = needsReview(experience);
        const color = graphNodeColor(experience);
        const size = 1.9 + clampScore(experience.importance) * 2.7;
        const confidence = clampScore(experience.confidence);
        const hasEntities = (experience.associatedEntityIds ?? []).length > 0;
        const connected = connectedIds.has(experience.id);
        return (
          <button
            key={experience.id}
            type="button"
            aria-label={`Select experience: ${experience.learning || experience.result || experience.context}`}
            data-testid={`experience-graph-node-${experience.id}`}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full outline-none transition duration-200 hover:scale-125 focus-visible:ring-2 focus-visible:ring-accent"
            style={{
              left: `${position.x}%`,
              top: `${position.y}%`,
              width: `${size}rem`,
              height: `${size}rem`,
            }}
            onClick={() => onSelectExperience(experience.id)}
          >
            <span
              aria-hidden="true"
              className="absolute rounded-full blur-xl"
              style={{
                inset: "-42%",
                background: color.glow,
                opacity: connected ? 0.88 : 0.48,
              }}
            />
            {hasEntities ? (
              <span
                aria-hidden="true"
                className="absolute rounded-full border"
                style={{
                  inset: "-28%",
                  borderColor: color.ring,
                  opacity: 0.45 + confidence * 0.25,
                }}
              />
            ) : null}
            <span
              aria-hidden="true"
              className="absolute rounded-full border"
              style={{
                inset: selected ? "-20%" : review ? "-12%" : "-5%",
                borderColor: selected
                  ? "rgb(255 255 255)"
                  : review
                    ? color.ring
                    : "rgba(255,255,255,0.26)",
                opacity: selected ? 0.95 : review ? 0.72 : 0.38,
              }}
            />
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full border shadow-lg"
              style={{
                background: `radial-gradient(circle at 32% 28%, rgba(255,255,255,0.92), ${color.fill} 32%, rgba(15,23,42,0.88) 100%)`,
                borderColor: color.ring,
                boxShadow: selected
                  ? `0 0 0 10px ${color.glow}, 0 0 42px ${color.glow}`
                  : `0 0 ${connected ? 28 : 16}px ${color.glow}`,
                opacity: 0.48 + confidence * 0.5,
              }}
            />
            <span
              aria-hidden="true"
              className="absolute rounded-full bg-white/70"
              style={{
                top: "24%",
                left: "27%",
                width: "18%",
                height: "18%",
              }}
            />
          </button>
        );
      })}
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
        ...(experience.mergedExperienceIds ?? []),
        ...(experience.sourceMessageIds ?? []),
        ...(experience.keywords ?? []),
        ...(experience.associatedEntityIds ?? []),
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

      <ExperienceGraphPanel
        experiences={filteredExperiences}
        selectedExperienceId={visibleSelectedExperience?.id ?? null}
        onSelectExperience={onSelectExperience}
      />

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
                <div>
                  <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    Keywords
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {experienceKeywords(visibleSelectedExperience).length >
                    0 ? (
                      experienceKeywords(visibleSelectedExperience).map(
                        (keyword) => (
                          <span
                            key={keyword}
                            className="rounded-full border border-border/40 bg-bg/50 px-2 py-0.5 text-xs text-muted-strong"
                          >
                            {keyword}
                          </span>
                        ),
                      )
                    ) : (
                      <span className="text-sm text-muted">
                        No keywords recorded.
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted">
                    Graph metadata
                  </div>
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
