/**
 * Owner review and recovery controls for durable workspace deletion.
 * Confirmation binds to the complete displayed snapshot; uncertain requests
 * require a status refresh and never produce an optimistic completion notice.
 */
import { Button, Input } from "@elizaos/ui";
import { useId, useRef, useState } from "react";
import type {
  FamilyDeletionJob,
  FamilyDeletionPreview,
} from "../../lifeops/family-workflows/deletion-contracts.js";
import {
  defaultFamilyDeletionAdapter,
  type FamilyDeletionAdapter,
} from "./deletion-adapter.js";

const retentionLabels: Record<FamilyDeletionJob["backupRetention"], string> = {
  immediate: "Immediately",
  "7-days": "After 7 days",
  "30-days": "After 30 days",
};
const policies = [
  { value: "immediate", label: "Immediately" },
  { value: "7-days", label: "After 7 days" },
  { value: "30-days", label: "After 30 days" },
] as const;

export function FamilyDeletionPanel({
  adapter = defaultFamilyDeletionAdapter,
  onChange,
}: {
  adapter?: FamilyDeletionAdapter;
  onChange: () => Promise<void>;
}) {
  const reviewId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeRequest = useRef(false);
  const [preview, setPreview] = useState<FamilyDeletionPreview | null>(null);
  const [job, setJob] = useState<FamilyDeletionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [retention, setRetention] = useState<
    FamilyDeletionJob["backupRetention"] | null
  >(null);

  const perform = async (operation: () => Promise<void>) => {
    if (activeRequest.current) return;
    activeRequest.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      // error-policy:J1 Preserve the failure and require a fresh review/status before another deletion attempt.
      setPreview(null);
      setReviewed(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "Deletion status is unavailable.",
      );
    } finally {
      activeRequest.current = false;
      setBusy(false);
    }
  };
  const refresh = () =>
    perform(async () => {
      setPreview(null);
      setReviewed(false);
      const current = await adapter.status();
      setJob(current);
      if (!current) setPreview(await adapter.preview());
    });
  const begin = () =>
    perform(async () => {
      if (
        !preview ||
        !reviewed ||
        !retention ||
        preview.unavailable.length ||
        preview.records.some((record) => record.unsettled)
      ) {
        throw new Error(
          "Refresh the workspace review and choose a backup retention policy before deleting.",
        );
      }
      setJob(
        await adapter.begin({
          expectedSha256: preview.sha256,
          backupRetention: retention,
        }),
      );
      setPreview(null);
      setReviewed(false);
      await onChange();
    });
  const resume = () =>
    perform(async () => {
      setJob(await adapter.resume());
      await onChange();
    });

  if (!open)
    return (
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
      >
        Review workspace deletion
      </Button>
    );
  return (
    <section
      aria-label="Workspace deletion"
      className="grid gap-3 rounded-lg border border-border p-4 [&_button]:min-h-11"
    >
      <h2 className="text-lg font-semibold">Workspace deletion</h2>
      <p>
        Review the affected records before permanently removing this workspace.
        Export any records you want to keep first.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh deletion status
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Close deletion review
        </Button>
      </div>
      {busy ? <p role="status">Checking workspace deletion…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {job ? (
        <>
          <p role="status">
            {job.state === "purge_pending"
              ? "Access is revoked. Primary-file cleanup is still pending."
              : "Primary cleanup is verified. Backup cleanup is pending; deletion is not complete."}
          </p>
          <p>
            {job.databaseRowsRemoved} database records removed. Backup
            retention: {retentionLabels[job.backupRetention]}.
          </p>
          <p>
            Started {new Date(job.startedAt).toLocaleString()}. Operation{" "}
            {job.id}.
          </p>
          {job.retained.length ? (
            <div>
              <h3>Records retained</h3>
              <ul>
                {job.retained.map((record) => (
                  <li key={record.kind}>
                    {record.kind}: {record.count}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {job.state === "purge_pending" ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void resume()}
            >
              Retry primary cleanup
            </Button>
          ) : null}
        </>
      ) : null}
      {preview ? (
        <>
          {preview.unavailable.length ? (
            <p role="alert">
              Review is incomplete. Unavailable stores:{" "}
              {preview.unavailable.join(", ")}.
            </p>
          ) : null}
          {preview.records.some((record) => record.unsettled) ? (
            <p role="alert">
              Work is still in progress. Wait for it to settle, then refresh
              this review.
            </p>
          ) : null}
          <p>
            Owned family content is removed; the revocation record and deletion
            journal remain for recovery. Referenced, mixed, and unclassified
            records remain retained. Provider calendars and messages remain with
            their providers.
          </p>
          <details>
            <summary>
              Review all {preview.records.length} affected records
            </summary>
            <ul className="grid gap-3">
              {preview.records.map((record) => (
                <li key={`${record.kind}:${record.sha256}`}>
                  <strong>{record.kind}</strong> — {record.classification}
                  {record.unsettled ? "; work pending" : ""}
                  <pre className="whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(record.identity, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          </details>
          <fieldset disabled={busy} className="grid gap-2">
            <legend>Remove eligible backups</legend>
            <div className="flex flex-wrap gap-2">
              {policies.map((policy) => (
                <Button
                  key={policy.value}
                  type="button"
                  variant="choice"
                  aria-pressed={retention === policy.value}
                  data-state={retention === policy.value ? "on" : "off"}
                  onClick={() => setRetention(policy.value)}
                >
                  {policy.label}
                </Button>
              ))}
            </div>
          </fieldset>
          <label htmlFor={reviewId} className="flex min-h-11 items-start gap-2">
            <Input
              id={reviewId}
              type="checkbox"
              checked={reviewed}
              disabled={busy}
              onChange={(event) => setReviewed(event.target.checked)}
              className="h-5 w-5 shrink-0"
            />
            I reviewed these records and understand that removal is permanent.
          </label>
          <Button
            type="button"
            variant="destructive"
            disabled={
              busy ||
              !reviewed ||
              !retention ||
              preview.unavailable.length > 0 ||
              preview.records.some((record) => record.unsettled)
            }
            onClick={() => void begin()}
          >
            Delete reviewed workspace
          </Button>
        </>
      ) : null}
    </section>
  );
}
