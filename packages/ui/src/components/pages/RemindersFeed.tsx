import type {
  LifeOpsOccurrence,
  LifeOpsReminderAttempt,
  LifeOpsTaskDefinition,
} from "@elizaos/core/contracts/personal-assistant";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import { fetchWithCsrf } from "../../api/csrf-client";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";

type ReminderRow = {
  definition: LifeOpsTaskDefinition;
  occurrence: LifeOpsOccurrence | null;
  latestAttempt: LifeOpsReminderAttempt | null;
};
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetchWithCsrf(
    `${client.getBaseUrl()}/api/lifeops/${path}`,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  if (!res.ok) throw Error(`Reminder request failed (${res.status})`);
  return res.json();
}
export function reminderDeliveryLabel(row: ReminderRow): string {
  if (row.definition.status === "archived") return "cancelled";
  if (row.definition.status === "paused") return "paused";
  if (row.definition.status === "completed") return "completed";
  const state = row.occurrence?.state;
  if (
    state &&
    ["snoozed", "completed", "skipped", "expired", "muted"].includes(state)
  )
    return state;
  if (state && !["pending", "visible"].includes(state)) return "unknown";
  const outcome = row.latestAttempt?.outcome;
  if (outcome?.startsWith("delivered")) return "delivered";
  if (outcome?.startsWith("blocked")) return "blocked";
  if (outcome === "skipped_duplicate") return "duplicate";
  if (outcome) return "unknown";
  return row.occurrence ? "scheduled" : "unscheduled";
}
export function canSnoozeReminder(row: ReminderRow): boolean {
  return (
    row.definition.status === "active" &&
    !!row.occurrence &&
    ["pending", "visible", "snoozed"].includes(row.occurrence.state) &&
    !row.latestAttempt?.outcome.startsWith("delivered")
  );
}
export function RemindersFeed() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ReminderRow[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [message, setMessage] = useState(""),
    [editDue, setEditDue] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<{ reminders: ReminderRow[] }>("reminders");
      if (!Array.isArray(data.reminders))
        throw Error("Invalid reminders response");
      setRows(data.reminders);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load reminders");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const mutate = async (
    row: ReminderRow,
    verb: "edit" | "snooze" | "cancel",
  ) => {
    setBusy(row.definition.id);
    setError(null);
    try {
      if (verb === "snooze") {
        if (!row.occurrence)
          throw Error("No occurrence is available to snooze");
        await request(
          `occurrences/${encodeURIComponent(row.occurrence.id)}/snooze`,
          "POST",
          { minutes: 10 },
        );
      } else
        await request(
          `definitions/${encodeURIComponent(row.definition.id)}`,
          "PUT",
          verb === "cancel"
            ? { status: "archived" }
            : {
                title: message,
                ...(row.definition.cadence.kind === "once" && editDue
                  ? {
                      cadence: {
                        ...row.definition.cadence,
                        dueAt: new Date(editDue).toISOString(),
                      },
                    }
                  : {}),
              },
        );
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reminder change failed");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label={t("common.reminders")} className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("common.reminders")}</h2>
          <p className="text-sm text-muted">
            {t("automationsreminders.description")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
        >
          {t("common.refresh")}
        </Button>
      </header>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {loading && rows.length === 0 ? (
        <p role="status">{t("automationsreminders.loading")}</p>
      ) : rows.length === 0 && !error ? (
        <p>{t("automationsreminders.empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => {
            const due =
              row.occurrence?.snoozedUntil ??
              row.occurrence?.dueAt ??
              (row.definition.cadence.kind === "once"
                ? row.definition.cadence.dueAt
                : null);
            const cancelled = ["archived", "completed"].includes(row.definition.status);
            return (
              <li key={row.definition.id} className="space-y-2 py-4">
                <p className="font-medium break-words">
                  {row.definition.title}
                </p>
                {row.definition.description && (
                  <p className="text-sm whitespace-pre-wrap">
                    {row.definition.description}
                  </p>
                )}
                <p className="text-sm text-muted">
                  {due ? (
                    <time dateTime={due}>
                      {new Date(due).toLocaleString(undefined, {
                        timeZone: row.definition.timezone,
                        dateStyle: "full",
                        timeStyle: "long",
                      })}
                    </time>
                  ) : (
                    t("automationsreminders.noOccurrence")
                  )}
                </p>
                <p className="text-sm">
                  {t(
                    `automationsreminders.status.${reminderDeliveryLabel(row)}`,
                  )}
                  {row.latestAttempt?.attemptedAt && (
                    <>
                      {" "}
                      ·{" "}
                      <time dateTime={row.latestAttempt.attemptedAt}>
                        {new Date(row.latestAttempt.attemptedAt).toLocaleString(
                          undefined,
                          {
                            timeZone: row.definition.timezone,
                            dateStyle: "medium",
                            timeStyle: "short",
                          },
                        )}
                      </time>
                    </>
                  )}
                </p>
                {editing === row.definition.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void mutate(row, "edit");
                    }}
                    className="flex flex-wrap gap-2"
                  >
                    <label className="w-full">
                      {t("automationsreminders.message")}
                      <input
                        className="block w-full rounded border border-border bg-surface p-2"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        required
                      />
                    </label>
                    {row.definition.cadence.kind === "once" && (
                      <label className="w-full">
                        {t("automationsreminders.dueTime")} (
                        {Intl.DateTimeFormat().resolvedOptions().timeZone})
                        <input
                          type="datetime-local"
                          className="block w-full rounded border border-border bg-surface p-2"
                          value={editDue}
                          onChange={(e) => setEditDue(e.target.value)}
                          required
                        />
                      </label>
                    )}
                    <Button
                      type="submit"
                      disabled={busy !== null || !message.trim()}
                    >
                      {t("common.save")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setEditing(null)}
                    >
                      {t("common.back")}
                    </Button>
                  </form>
                ) : (
                  !cancelled && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => {
                          setEditing(row.definition.id);
                          setMessage(row.definition.title);
                          const date = due ? new Date(due) : null;
                          setEditDue(
                            date
                              ? new Date(
                                  date.getTime() -
                                    date.getTimezoneOffset() * 60000,
                                )
                                  .toISOString()
                                  .slice(0, 16)
                              : "",
                          );
                        }}
                      >
                        {t("automationsreminders.editMessage")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null || !canSnoozeReminder(row)}
                        onClick={() => void mutate(row, "snooze")}
                      >
                        {t("automationsreminders.snooze")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void mutate(row, "cancel")}
                      >
                        {t("automationsreminders.cancel")}
                      </Button>
                    </div>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
