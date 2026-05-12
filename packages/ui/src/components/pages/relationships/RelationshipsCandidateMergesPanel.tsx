import { Button } from "../../ui/button";
import { MetaPill } from "../../composites/page-panel/page-panel-header";
import { PagePanel } from "../../composites/page-panel";
import {
  CalendarClock,
  Check,
  FileText,
  Fingerprint,
  Gauge,
  X,
} from "lucide-react";
import { useState } from "react";
import { client } from "../../../api/client";
import type {
  RelationshipsGraphSnapshot,
  RelationshipsMergeCandidate,
} from "../../../api/client-types-relationships";
import { formatDateTime } from "../../../utils/format";
import { evidenceSummary, personLabel } from "./relationships-utils";

export function RelationshipsCandidateMergesPanel({
  graph,
  onResolved,
}: {
  graph: RelationshipsGraphSnapshot;
  onResolved: () => void;
}) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const candidates = graph.candidateMerges;

  if (candidates.length === 0) {
    return null;
  }

  const setError = (id: string, message: string | null) => {
    setErrors((previous) => {
      const next = new Map(previous);
      if (message === null) {
        next.delete(id);
      } else {
        next.set(id, message);
      }
      return next;
    });
  };

  const setPendingState = (id: string, isPending: boolean) => {
    setPending((previous) => {
      const next = new Set(previous);
      if (isPending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const resolveCandidate = async (
    candidate: RelationshipsMergeCandidate,
    action: "accept" | "reject",
  ) => {
    setPendingState(candidate.id, true);
    setError(candidate.id, null);
    try {
      if (action === "accept") {
        await client.acceptRelationshipsCandidate(candidate.id);
      } else {
        await client.rejectRelationshipsCandidate(candidate.id);
      }
      onResolved();
    } catch (err) {
      setError(
        candidate.id,
        err instanceof Error
          ? err.message
          : `Failed to ${action} merge proposal.`,
      );
    } finally {
      setPendingState(candidate.id, false);
    }
  };

  return (
    <PagePanel
      as="section"
      variant="surface"
      aria-label="Identity merges"
      className="px-3 py-3"
    >
      <div className="mb-2 flex justify-end">
        <MetaPill
          compact
          aria-label="Identity merge count"
          title="Identity merges"
        >
          <Fingerprint className="mr-1 h-3 w-3" />
          {candidates.length}
        </MetaPill>
      </div>

      <div className="space-y-2">
        {candidates.map((candidate) => {
          const isPending = pending.has(candidate.id);
          const errorMessage = errors.get(candidate.id) ?? null;
          const evidenceCount = candidate.evidence.identityIds?.length ?? 0;
          const evidenceText = evidenceSummary(candidate);
          return (
            <div
              key={candidate.id}
              className="rounded-xl border border-border/24 bg-card/32 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <MetaPill compact>
                  <span
                    role="img"
                    aria-label="Confidence"
                    className="inline-flex items-center gap-1"
                  >
                    <Gauge className="h-3 w-3" />
                    {Math.round(candidate.confidence * 100)}%
                  </span>
                </MetaPill>
                <MetaPill compact>
                  <span
                    role="img"
                    aria-label="Evidence count"
                    className="inline-flex items-center gap-1"
                  >
                    <FileText className="h-3 w-3" />
                    {evidenceCount}
                  </span>
                </MetaPill>
                <MetaPill compact>
                  <span
                    role="img"
                    aria-label="Proposed at"
                    className="inline-flex items-center gap-1"
                  >
                    <CalendarClock className="h-3 w-3" />
                    {formatDateTime(candidate.proposedAt, {
                      fallback: "No date",
                    })}
                  </span>
                </MetaPill>
              </div>
              <div className="mt-2 text-sm font-semibold text-txt">
                {personLabel(graph, candidate.entityA)}{" "}
                <span className="text-muted">↔</span>{" "}
                {personLabel(graph, candidate.entityB)}
              </div>
              {evidenceText !== "No evidence" ? (
                <div className="mt-1 truncate text-xs leading-5 text-muted">
                  {evidenceText}
                </div>
              ) : null}
              {errorMessage ? (
                <div className="mt-2 text-xs text-danger">{errorMessage}</div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  className="h-7 gap-1.5 rounded-full px-2.5 text-2xs"
                  disabled={isPending}
                  onClick={() => {
                    void resolveCandidate(candidate, "accept");
                  }}
                >
                  <Check className="h-3 w-3" />
                  {isPending ? "Working…" : "Accept"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 rounded-full px-2.5 text-2xs"
                  disabled={isPending}
                  onClick={() => {
                    void resolveCandidate(candidate, "reject");
                  }}
                >
                  <X className="h-3 w-3" />
                  Reject
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </PagePanel>
  );
}
