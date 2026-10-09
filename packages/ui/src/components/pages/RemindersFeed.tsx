import type {
  CreateLifeOpsDefinitionRequest,
  LifeOpsDefinitionCreationResult,
  LifeOpsOccurrence,
  LifeOpsReminderAttempt,
  LifeOpsTaskDefinition,
} from "@elizaos/contracts";
import { Bell, CalendarClock, ChevronDown } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface/useAgentElement";
import { client } from "../../api/client";
import { ApiError, isApiError } from "../../api/client-types-core";
import {
  getActiveAgentAuthority,
  useActiveAgentAuthority,
} from "../../hooks/useActiveAgentAuthority";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StatusDot } from "../ui/status-badge";
import { Textarea } from "../ui/textarea";

type ReminderRow = {
  definition: LifeOpsTaskDefinition;
  occurrence: LifeOpsOccurrence | null;
  latestAttempt: LifeOpsReminderAttempt | null;
};
async function request<T>(
  baseUrl: string,
  authority: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (
    client.getBaseUrl() !== baseUrl ||
    getActiveAgentAuthority() !== authority
  )
    throw new ApiError({
      kind: "http",
      path: `/api/lifeops/${path}`,
      status: 409,
      message: "The selected agent changed before the reminder request",
    });
  const controller = new AbortController();
  const unsubscribe = client.onAuthorityChange(() => {
    if (getActiveAgentAuthority() !== authority) controller.abort();
  });
  try {
    const res = await client.rawRequest(`/api/lifeops/${path}`, {
      method,
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok)
      throw new ApiError({
        kind: "http",
        path: `/api/lifeops/${path}`,
        status: res.status,
        message: `Reminder request failed (${res.status})`,
      });
    const result = await res.json();
    if (getActiveAgentAuthority() !== authority)
      throw new ApiError({
        kind: "http",
        path: `/api/lifeops/${path}`,
        status: 409,
        message: "The selected agent changed during the reminder request",
      });
    return result;
  } finally {
    unsubscribe();
  }
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
    !row.occurrence.metadata?.reminderAcknowledgedAt
  );
}
export type ReminderCounts = { all: number; active: number; inactive: number };
export interface RemindersFeedHandle {
  refresh(): Promise<void>;
}

type RemindersFeedProps = {
  baseUrl?: string;
  filter?: "all" | "active" | "inactive";
  hideEmpty?: boolean;
  ref?: Ref<RemindersFeedHandle>;
  onCountsChange?: (counts: ReminderCounts | null) => void;
};

export function RemindersFeed(props: RemindersFeedProps) {
  const authority = useActiveAgentAuthority();
  // A new principal must not inherit rows, edits, or pending callbacks.
  return (
    <AuthorityRemindersFeed key={authority} {...props} authority={authority} />
  );
}

function AuthorityRemindersFeed({
  ref,
  filter = "all",
  hideEmpty = false,
  onCountsChange,
  baseUrl = client.getBaseUrl(),
  authority,
}: RemindersFeedProps & { authority: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ReminderRow[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [message, setMessage] = useState(""),
    [editDue, setEditDue] = useState("");
  const [originalDue, setOriginalDue] = useState<string | null>(null);
  const mounted = useRef(false);
  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    if (!mounted.current) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    onCountsChange?.(null);
    try {
      const data = await request<{ reminders: ReminderRow[] }>(
        baseUrl,
        authority,
        "reminders",
      );
      if (generation !== loadGeneration.current) return;
      if (!Array.isArray(data.reminders))
        throw Error("Invalid reminders response");
      setRows(data.reminders);
      const active = data.reminders.filter(
        (row) => row.definition.status === "active",
      ).length;
      onCountsChange?.({
        all: data.reminders.length,
        active,
        inactive: data.reminders.length - active,
      });
      setError(null);
    } catch (e) {
      if (generation === loadGeneration.current)
        setError(
          t(
            isApiError(e) && (e.status === 404 || e.status === 501)
              ? "automationsreminders.unavailable"
              : isApiError(e) && (e.status === 401 || e.status === 403)
                ? "automationsreminders.permissionRequired"
                : "automationsreminders.loadFailed",
          ),
        );
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [baseUrl, authority, onCountsChange, t]);
  useImperativeHandle(ref, () => ({ refresh: load }), [load]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadGeneration.current += 1;
    };
  }, [load]);
  const mutate = async (
    row: ReminderRow,
    verb: "edit" | "snooze" | "cancel",
  ) => {
    setBusy(row.definition.id);
    setError(null);
    try {
      if (client.getBaseUrl() !== baseUrl)
        throw Error(t("automationsreminders.agentChanged"));
      if (verb === "snooze") {
        if (!row.occurrence)
          throw Error("No occurrence is available to snooze");
        await request(
          baseUrl,
          authority,
          `occurrences/${encodeURIComponent(row.occurrence.id)}/snooze`,
          "POST",
          { minutes: 10 },
        );
      } else
        await request(
          baseUrl,
          authority,
          `definitions/${encodeURIComponent(row.definition.id)}`,
          "PUT",
          verb === "cancel"
            ? { status: "archived" }
            : {
                ...(row.definition.cadence.kind === "once" &&
                row.definition.metadata?.ownerSurface === "OWNER_REMINDERS" &&
                row.definition.description?.trim()
                  ? { description: message }
                  : { title: message }),
                ...(row.definition.cadence.kind === "once" &&
                editDue &&
                originalDue &&
                editDue !==
                  new Date(
                    new Date(originalDue).getTime() -
                      new Date(originalDue).getTimezoneOffset() * 60000,
                  )
                    .toISOString()
                    .slice(0, -1)
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
  const visibleRows = rows.filter(
    (row) =>
      filter === "all" ||
      (row.definition.status === "active") === (filter === "active"),
  );
  if (hideEmpty && !loading && !error && visibleRows.length === 0) return null;
  return (
    <section
      aria-label={t("common.reminders")}
      className="border-b border-border/40"
    >
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {loading && rows.length === 0 ? (
        <p role="status">{t("automationsreminders.loading")}</p>
      ) : visibleRows.length === 0 && !error ? (
        <p>{t("automationsreminders.empty")}</p>
      ) : (
        <ul className="divide-y divide-border/40">
          {visibleRows.map((row) => {
            const due =
              row.occurrence?.snoozedUntil ??
              row.occurrence?.dueAt ??
              (row.definition.cadence.kind === "once"
                ? row.definition.cadence.dueAt
                : null);
            const hasBody =
              row.definition.cadence.kind === "once" &&
              row.definition.metadata?.ownerSurface === "OWNER_REMINDERS" &&
              Boolean(row.definition.description?.trim());
            const cancelled = ["archived", "completed"].includes(
              row.definition.status,
            );
            return (
              <ReminderFeedRow key={row.definition.id} row={row}>
                {editing === row.definition.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void mutate(row, "edit");
                    }}
                    className="flex flex-wrap gap-2"
                  >
                    <label
                      className="w-full"
                      htmlFor={`reminder-message-${row.definition.id}`}
                    >
                      {t("automationsreminders.message")}
                      {hasBody ? (
                        <Textarea
                          id={`reminder-message-${row.definition.id}`}
                          className="mt-1"
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          required
                        />
                      ) : (
                        <Input
                          id={`reminder-message-${row.definition.id}`}
                          className="mt-1"
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          required
                        />
                      )}
                    </label>
                    {row.definition.cadence.kind === "once" && (
                      <label
                        className="w-full"
                        htmlFor={`reminder-due-${row.definition.id}`}
                      >
                        {t("automationsreminders.dueTime")} (
                        {Intl.DateTimeFormat().resolvedOptions().timeZone})
                        <Input
                          id={`reminder-due-${row.definition.id}`}
                          type="datetime-local"
                          step="0.001"
                          className="mt-1"
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
                          setMessage(
                            hasBody
                              ? row.definition.description
                              : row.definition.title,
                          );
                          setOriginalDue(due);
                          const date = due ? new Date(due) : null;
                          setEditDue(
                            date
                              ? new Date(
                                  date.getTime() -
                                    date.getTimezoneOffset() * 60000,
                                )
                                  .toISOString()
                                  .slice(0, -1)
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
              </ReminderFeedRow>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A disclosure row shares the automation list's density and exposes exact details on demand. */
function ReminderFeedRow({
  row,
  children,
}: {
  row: ReminderRow;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const deliveryLabel = reminderDeliveryLabel(row);
  const successful =
    deliveryLabel === "delivered" || deliveryLabel === "completed";
  const due =
    row.occurrence?.snoozedUntil ??
    row.occurrence?.dueAt ??
    (row.definition.cadence.kind === "once"
      ? row.definition.cadence.dueAt
      : null);
  const openAction = useAgentElement<HTMLButtonElement>({
    id: `open-reminder-${row.definition.id}`,
    role: "button",
    label: row.definition.title,
    group: "automations-list",
    description: "Expand reminder details and edit, snooze, or cancel controls",
    status: expanded ? "expanded" : "collapsed",
    onActivate: () => setExpanded((current) => !current),
  });
  return (
    <li className="group transition-colors hover:bg-bg-accent/40">
      <Button
        ref={openAction.ref}
        type="button"
        variant="transparent"
        size="rowContent"
        align="start"
        className="w-full min-w-0 items-center whitespace-normal py-3"
        aria-label={row.definition.title}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
        {...openAction.agentProps}
      >
        <Bell className="size-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`max-w-full text-sm font-medium text-txt ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}
            >
              {row.definition.title}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 text-xs ${successful ? "text-ok-foreground" : "text-muted-strong"}`}
            >
              <StatusDot tone={successful ? "success" : "muted"} />
              {t(`automationsreminders.status.${deliveryLabel}`)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-strong">
            <CalendarClock className="size-3 shrink-0" aria-hidden />
            {due ? (
              <time dateTime={due}>
                {new Date(due).toLocaleString(undefined, {
                  timeZone: row.definition.timezone,
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            ) : (
              t("automationsreminders.noOccurrence")
            )}
          </div>
        </div>
        <ChevronDown
          className={`size-3.5 shrink-0 text-muted-strong transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden
        />
      </Button>
      {expanded && (
        <div id={detailsId} className="space-y-3 pb-4 pl-7 pr-3 text-sm">
          {row.definition.description && (
            <p className="whitespace-pre-wrap break-words">
              {row.definition.description}
            </p>
          )}
          <p className="text-muted-strong">
            {due ? (
              <time dateTime={due}>
                {new Date(due).toLocaleString(undefined, {
                  timeZone: row.definition.timezone,
                  dateStyle: "full",
                  timeStyle: "long",
                })}{" "}
                ({row.definition.timezone})
              </time>
            ) : (
              t("automationsreminders.noOccurrence")
            )}
          </p>
          {row.latestAttempt?.attemptedAt && (
            <p className="text-muted-strong">
              {t(
                `automationsreminders.status.${row.latestAttempt.outcome.startsWith("delivered") ? "delivered" : row.latestAttempt.outcome.startsWith("blocked") ? "blocked" : "unknown"}`,
              )}{" "}
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
            </p>
          )}
          {children}
        </div>
      )}
    </li>
  );
}

type ReminderEditorProps = {
  onSaved: () => void;
  onCancel: () => void;
  baseUrl?: string;
};

export function ReminderEditor(props: ReminderEditorProps) {
  const authority = useActiveAgentAuthority();
  // Draft and retry identity belong to the principal who began this editor.
  return (
    <AuthorityReminderEditor key={authority} {...props} authority={authority} />
  );
}

function AuthorityReminderEditor({
  onSaved,
  onCancel,
  baseUrl = client.getBaseUrl(),
  authority,
}: ReminderEditorProps & { authority: string }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const dispatchedRequest = useRef<CreateLifeOpsDefinitionRequest | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (client.getBaseUrl() !== baseUrl)
        throw Error(t("automationsreminders.agentChanged"));
      const dueAt = new Date(due);
      if (
        !dispatchedRequest.current &&
        (!message.trim() ||
          !Number.isFinite(dueAt.getTime()) ||
          dueAt.getTime() <= Date.now())
      )
        throw Error(t("automationsreminders.futureTime"));
      const payload: CreateLifeOpsDefinitionRequest = {
        idempotencyKey,
        kind: "habit",
        title: message.trim(),
        timezone,
        cadence: {
          kind: "once",
          dueAt: dueAt.toISOString(),
          visibilityLeadMinutes: 0,
        },
        metadata: {
          ownerSurface: "OWNER_REMINDERS",
          nativeProjection: "in_app_only",
        },
        reminderPlan: {
          steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
        },
      };
      dispatchedRequest.current ??= payload;
      setSubmitted(true);
      const result = await request<LifeOpsDefinitionCreationResult>(
        baseUrl,
        authority,
        "definitions",
        "POST",
        dispatchedRequest.current,
      );
      if (!result.definition?.id)
        throw Error(t("automationsreminders.createFailed"));
      if (mounted.current && getActiveAgentAuthority() === authority) onSaved();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("automationsreminders.createFailed"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mx-auto w-full max-w-xl space-y-6 py-4">
      <h2 className="text-xl font-semibold">
        {t("automationsreminders.newReminder")}
      </h2>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="block space-y-2">
          <span>{t("automationsreminders.message")}</span>
          <input
            className="w-full rounded border border-border bg-surface p-3"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
            disabled={busy || submitted}
          />
        </label>
        <label className="block space-y-2">
          <span>
            {t("automationsreminders.dueTime")} ({timezone})
          </span>
          <input
            className="w-full rounded border border-border bg-surface p-3"
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            required
            disabled={busy || submitted}
          />
        </label>
        <p className="text-sm text-muted">
          {t("automationsreminders.inAppDelivery")}
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !message.trim() || !due}>
            {t("common.create")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onCancel}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    </section>
  );
}
