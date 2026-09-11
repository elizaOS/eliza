/** Guided review for replacing test Google accounts without silently changing an approved sender. */
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import { useState } from "react";
import {
  retireReplacedAccount,
  reviewAccountTransition,
} from "./account-transition.js";
import type {
  LifeOpsConnectionsAdapter,
  LifeOpsConnectionsSnapshot,
} from "./types.js";

export function AccountTransitionPanel({
  snapshot,
  adapter,
  refresh,
}: {
  snapshot: LifeOpsConnectionsSnapshot;
  adapter: LifeOpsConnectionsAdapter;
  refresh: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [previousGrantId, setPrevious] = useState("");
  const [replacementGrantId, setReplacement] = useState("");
  const [review, setReview] = useState<ReturnType<
    typeof reviewAccountTransition
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const accounts = snapshot.googleAccounts.filter(
    (account) => account.connected && account.grant,
  );
  async function run(retire: boolean) {
    setBusy(true);
    setError(null);
    try {
      const selection = { previousGrantId, replacementGrantId };
      if (retire) {
        await retireReplacedAccount(adapter, selection);
        setComplete(true);
        setReview(null);
        await refresh();
      } else {
        setReview(
          reviewAccountTransition(
            await adapter.load({ forceSync: true }),
            selection,
          ),
        );
      }
    } catch (cause) {
      // error-policy:J4 Connection and retirement failures stay visible and never imply a completed handoff.
      setReview(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "Account replacement failed. Refresh connection status.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: 22,
        padding: 24,
        marginBottom: 16,
        background: "var(--card)",
      }}
      aria-labelledby="account-transition-title"
    >
      <h2 id="account-transition-title">Switch from test to real accounts</h2>
      <p>
        Connect your real Google account below, select its calendars, then check
        it here before disconnecting the test account.
      </p>
      <p>
        Review automation destinations and create a fresh monthly email draft
        for the real recipient. Existing email approvals keep their original
        sender. Disconnecting does not transfer events or erase imported
        history.
      </p>
      <Button
        onClick={() => setExpanded(!expanded)}
        disabled={busy}
        aria-expanded={expanded}
      >
        {expanded ? "Close account replacement" : "Replace an account"}
      </Button>
      {expanded ? (
        <>
          <div className="lifeops-grid">
            {(["previous", "replacement"] as const).map((kind) => (
              <div className="lifeops-field" key={kind}>
                <label htmlFor={`handoff-${kind}`}>
                  {kind === "previous"
                    ? "Test account to disconnect"
                    : "Real account to keep"}
                </label>
                <Select
                  value={
                    kind === "previous" ? previousGrantId : replacementGrantId
                  }
                  onValueChange={(value) => {
                    if (kind === "previous") setPrevious(value);
                    else setReplacement(value);
                    setReview(null);
                    setComplete(false);
                  }}
                  disabled={busy}
                >
                  <SelectTrigger id={`handoff-${kind}`}>
                    <SelectValue placeholder="Choose an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((account) =>
                      account.grant ? (
                        <SelectItem
                          key={account.grant.id}
                          value={account.grant.id}
                        >
                          {account.grant.identityEmail ||
                            "Identity unavailable"}
                        </SelectItem>
                      ) : null,
                    )}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <Button
            disabled={
              busy ||
              !previousGrantId ||
              !replacementGrantId ||
              previousGrantId === replacementGrantId
            }
            onClick={() => void run(false)}
          >
            Check replacement connection
          </Button>
          {review ? (
            <div role="status">
              <p>
                Disconnect <strong>{review.previousEmail}</strong>. Keep{" "}
                <strong>{review.replacementEmail}</strong>.
              </p>
              {review.calendars.length ? (
                <p>Replacement calendars: {review.calendars.join(", ")}.</p>
              ) : null}
              <p>
                The old calendars will leave the combined feed. Imported history
                stays available until you purge it separately. This check
                verifies connection health; it does not send a test email.
              </p>
              <Button disabled={busy} onClick={() => void run(true)}>
                Disconnect reviewed test account
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {complete ? (
        <p role="status">
          Test account disconnected. Review the real recipient and automation
          destinations before using them.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
