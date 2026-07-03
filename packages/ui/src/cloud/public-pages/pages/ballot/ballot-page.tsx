/**
 * Hosted public page for a secret-ballot vote submission. Participants reach
 * this page from a DM-delivered scoped-token URL, paste their token, and vote.
 * The POST is unauthenticated and gated on the token hash server-side.
 */

import { AlertCircle, CheckCircle2, Loader2, Vote } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { Textarea } from "../../../../components/ui/textarea";
import { ApiError, api } from "../../../lib/api-client";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

type TFn = ReturnType<typeof useCloudT>;

type BallotStatus = "open" | "tallied" | "expired" | "canceled";

interface PublicBallot {
  id: string;
  organizationId: string;
  purpose: string;
  threshold: number;
  status: BallotStatus;
  participants: Array<{ identityId: string; label?: string }>;
  expiresAt: string;
  createdAt: string;
}

interface GetResponse {
  success: boolean;
  ballot: PublicBallot;
}

interface VoteResponse {
  success: boolean;
  outcome?: "recorded" | "replay_same_value";
  ballotStatus?: BallotStatus;
  error?: string;
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function normalizeError(error: unknown, t: TFn): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return t("cloud.ballot.unableToLoad", {
    defaultValue: "Unable to load ballot.",
  });
}

export default function BallotPage() {
  const t = useCloudT();
  const { ballotId } = useParams<{ ballotId: string }>();
  const [searchParams] = useSearchParams();
  const presetToken = searchParams.get("token") ?? "";
  const [ballot, setBallot] = useState<PublicBallot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scopedToken, setScopedToken] = useState(presetToken);
  const [value, setValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  usePageTitle(
    t("cloud.ballot.metaTitle", { defaultValue: "Ballot | Eliza Cloud" }),
  );

  const load = useCallback(async () => {
    if (!ballotId) {
      setError(
        t("cloud.ballot.missingId", { defaultValue: "Missing ballot id." }),
      );
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await api<GetResponse>(
        `/api/v1/ballots/${encodeURIComponent(ballotId)}?public=1`,
        { skipAuth: true },
      );
      setBallot(response.ballot);
    } catch (loadError) {
      setError(normalizeError(loadError, t));
    } finally {
      setIsLoading(false);
    }
  }, [ballotId, t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = useCallback(async () => {
    if (!ballotId || !scopedToken.trim() || !value.trim()) return;
    setIsSubmitting(true);
    setSubmitMessage(null);
    try {
      const response = await api<VoteResponse>(
        `/api/v1/ballots/${encodeURIComponent(ballotId)}/vote`,
        {
          method: "POST",
          json: { scopedToken: scopedToken.trim(), value: value.trim() },
          skipAuth: true,
        },
      );
      if (response.success) {
        const replay = response.outcome === "replay_same_value";
        setSubmitMessage(
          replay
            ? t("cloud.ballot.alreadyRecorded", {
                defaultValue: "Vote already recorded.",
              })
            : t("cloud.ballot.recorded", { defaultValue: "Vote recorded." }),
        );
      } else {
        setSubmitMessage(
          response.error ??
            t("cloud.ballot.unableToRecord", {
              defaultValue: "Unable to record vote.",
            }),
        );
      }
    } catch (submitError) {
      setSubmitMessage(normalizeError(submitError, t));
    } finally {
      setIsSubmitting(false);
    }
  }, [ballotId, scopedToken, value, t]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error || !ballot) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <AlertCircle className="mx-auto h-8 w-8 text-red-500" />
        <p className="mt-4 text-sm text-gray-700">
          {error ??
            t("cloud.ballot.notFound", { defaultValue: "Ballot not found." })}
        </p>
      </div>
    );
  }

  const isClosed = ballot.status !== "open";

  return (
    <div className="mx-auto max-w-lg space-y-6 py-12">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Vote className="h-4 w-4" />
          <span>
            {t("cloud.ballot.secretBallot", { defaultValue: "Secret ballot" })}
          </span>
        </div>
        <h1 className="text-2xl font-semibold">{ballot.purpose}</h1>
        <p className="text-sm text-gray-600">
          {t("cloud.ballot.participantsRequired", {
            threshold: ballot.threshold,
            total: ballot.participants.length,
            defaultValue: "{{threshold}} of {{total}} participants required.",
          })}
        </p>
        <p className="text-xs text-gray-500">
          {t("cloud.ballot.expires", {
            when:
              formatDate(ballot.expiresAt) ??
              t("cloud.ballot.soon", { defaultValue: "soon" }),
            defaultValue: "Expires {{when}}.",
          })}
        </p>
      </header>

      {isClosed ? (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
          {t("cloud.ballot.closed", {
            status: ballot.status,
            defaultValue:
              "This ballot is {{status}} and is no longer accepting votes.",
          })}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label htmlFor="ballot-scoped-token" className="block text-sm">
            <span className="text-gray-700">
              {t("cloud.ballot.scopedToken", {
                defaultValue: "Your scoped token",
              })}
            </span>
            <Input
              id="ballot-scoped-token"
              type="text"
              value={scopedToken}
              onChange={(event) => setScopedToken(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="sb_..."
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
          <label htmlFor="ballot-vote" className="block text-sm">
            <span className="text-gray-700">
              {t("cloud.ballot.yourVote", { defaultValue: "Your vote" })}
            </span>
            <Textarea
              id="ballot-vote"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              rows={3}
              required
            />
          </label>
          <Button
            variant="ghost"
            type="submit"
            disabled={isSubmitting || !scopedToken.trim() || !value.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-[#FF5800] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#e54f00] disabled:opacity-50"
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {t("cloud.ballot.submitVote", { defaultValue: "Submit vote" })}
          </Button>
        </form>
      )}

      {submitMessage ? (
        <div className="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-700">
          {submitMessage}
        </div>
      ) : null}
    </div>
  );
}
