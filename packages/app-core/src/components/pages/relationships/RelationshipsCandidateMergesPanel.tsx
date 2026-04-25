import { Button, MetaPill, PagePanel } from "@elizaos/ui";
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
    <PagePanel variant="surface" className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            Identity merges
          </div>
          <div className="mt-2 text-lg font-semibold text-txt">
            Pending merge proposals
          </div>
          <p className="mt-1 text-xs text-muted">
            Two entities look like the same person. Accept to fold them, reject
            to leave them separate.
          </p>
        </div>
        <MetaPill compact>{candidates.length}</MetaPill>
      </div>

      <div className="mt-4 space-y-3">
        {candidates.map((candidate) => {
          const isPending = pending.has(candidate.id);
          const errorMessage = errors.get(candidate.id) ?? null;
          const evidenceCount = candidate.evidence.identityIds?.length ?? 0;
          const evidenceText = evidenceSummary(candidate);
          return (
            <div
              key={candidate.id}
              className="rounded-2xl border border-border/24 bg-card/32 px-3.5 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <MetaPill compact>
                  {Math.round(candidate.confidence * 100)}% confidence
                </MetaPill>
                <MetaPill compact>{evidenceCount} evidence</MetaPill>
                <MetaPill compact>
                  {formatDateTime(candidate.proposedAt, {
                    fallback: "No date",
                  })}
                </MetaPill>
              </div>
              <div className="mt-2 text-sm font-semibold text-txt">
                {personLabel(graph, candidate.entityA)}{" "}
                <span className="text-muted">↔</span>{" "}
                {personLabel(graph, candidate.entityB)}
              </div>
              {evidenceText !== "No evidence" ? (
                <div className="mt-1 text-xs leading-5 text-muted">
                  {evidenceText}
                </div>
              ) : null}
              {errorMessage ? (
                <div className="mt-2 text-xs text-danger">{errorMessage}</div>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  disabled={isPending}
                  onClick={() => {
                    void resolveCandidate(candidate, "accept");
                  }}
                >
                  {isPending ? "Working…" : "Accept merge"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => {
                    void resolveCandidate(candidate, "reject");
                  }}
                >
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
