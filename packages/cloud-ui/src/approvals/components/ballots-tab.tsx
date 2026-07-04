/**
 * Ballots tab: lists the owner's secret ballots with inline tally / cancel, and
 * a per-ballot vote form (paste scoped token + value) for when the owner holds a
 * participant token. Votes are gated server-side on the token hash, not the
 * session, so the owner can only vote with a real scoped token they were issued.
 */

import { CheckCircle2, Loader2, Vote } from "lucide-react";
import { useCallback, useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Input,
  Textarea,
} from "@elizaos/ui/components/primitives";
import {
  type Ballot,
  formatApprovalTimestamp,
  useBallots,
  useCancelBallot,
  useTallyBallot,
  useVoteBallot,
} from "../lib/approvals";
import { StatusBadge } from "./status-badge";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function BallotCard({ ballot }: { ballot: Ballot }) {
  const tally = useTallyBallot();
  const cancel = useCancelBallot();
  const vote = useVoteBallot();
  const [scopedToken, setScopedToken] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voteMessage, setVoteMessage] = useState<string | null>(null);

  const isOpen = ballot.status === "open";
  const busy = tally.isPending || cancel.isPending || vote.isPending;
  const expiresAt = formatApprovalTimestamp(ballot.expiresAt);
  const voteCount = ballot.tallyResult?.totalVotes ?? null;

  const handleTally = useCallback(async () => {
    setError(null);
    try {
      const result = await tally.mutateAsync({ id: ballot.id });
      if (!result.tallied) {
        setError("Threshold not met yet — not enough votes to tally.");
      }
    } catch (caught) {
      setError(errorMessage(caught, "Failed to tally ballot."));
    }
  }, [ballot.id, tally]);

  const handleCancel = useCallback(async () => {
    setError(null);
    try {
      await cancel.mutateAsync({ id: ballot.id });
    } catch (caught) {
      setError(errorMessage(caught, "Failed to cancel ballot."));
    }
  }, [ballot.id, cancel]);

  const handleVote = useCallback(async () => {
    if (!scopedToken.trim() || !value.trim()) return;
    setError(null);
    setVoteMessage(null);
    try {
      const result = await vote.mutateAsync({
        id: ballot.id,
        scopedToken: scopedToken.trim(),
        value: value.trim(),
      });
      setVoteMessage(
        result.outcome === "replay_same_value"
          ? "Vote already recorded."
          : "Vote recorded.",
      );
      setValue("");
    } catch (caught) {
      setError(errorMessage(caught, "Unable to record vote."));
    }
  }, [ballot.id, scopedToken, value, vote]);

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Vote className="h-5 w-5 text-accent" />
          <div>
            <p className="text-sm font-medium text-txt">{ballot.purpose}</p>
            <p className="text-xs text-muted">
              {ballot.threshold} of {ballot.participants.length} required
              {voteCount !== null ? ` · ${voteCount} votes` : ""}
              {expiresAt ? ` · expires ${expiresAt}` : ""}
            </p>
          </div>
        </div>
        <StatusBadge status={ballot.status} />
      </div>

      {ballot.tallyResult ? (
        <div className="mt-3 rounded bg-surface p-3 text-xs text-muted-strong">
          <p className="font-medium text-txt">Tally</p>
          <ul className="mt-1 space-y-0.5">
            {Object.entries(ballot.tallyResult.counts).map(([key, count]) => (
              <li key={key}>
                {key}: {count}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <Alert className="mt-3" variant="destructive">
          <AlertTitle>Ballot issue</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {voteMessage ? (
        <p className="mt-3 text-xs text-success">{voteMessage}</p>
      ) : null}

      {isOpen ? (
        <div className="mt-4 space-y-3">
          <div className="space-y-2">
            <label
              htmlFor={`ballot-token-${ballot.id}`}
              className="block text-xs font-medium text-muted"
            >
              Vote with a scoped token
            </label>
            <Input
              id={`ballot-token-${ballot.id}`}
              value={scopedToken}
              onChange={(event) => setScopedToken(event.target.value)}
              placeholder="sb_..."
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              className="font-mono text-xs"
            />
            <Textarea
              value={value}
              onChange={(event) => setValue(event.target.value)}
              rows={2}
              placeholder="Your vote"
              disabled={busy}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void handleVote()}
              disabled={busy || !scopedToken.trim() || !value.trim()}
            >
              {vote.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Submit vote
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleTally()}
              disabled={busy}
            >
              {tally.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Tally
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void handleCancel()}
              disabled={busy}
            >
              Cancel ballot
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function BallotsTab() {
  const query = useBallots();

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load ballots</AlertTitle>
        <AlertDescription>
          {errorMessage(query.error, "Try again in a moment.")}
        </AlertDescription>
      </Alert>
    );
  }

  const open = (query.data ?? []).filter((ballot) => ballot.status === "open");

  if (open.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted">No open ballots.</p>
    );
  }

  return (
    <div className="space-y-3">
      {open.map((ballot) => (
        <BallotCard key={ballot.id} ballot={ballot} />
      ))}
    </div>
  );
}
