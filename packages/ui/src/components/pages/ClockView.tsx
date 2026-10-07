/** Clock displays native-owned alarms and preserves the agent's reviewed proposal path. */
import {
  type ClockAlarmOperation,
  type ClockAlarmRecord,
  clockCapabilityAvailable,
} from "@elizaos/plugin-assistant/device-clock-review";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAgentElement } from "../../agent-surface/useAgentElement";
import {
  type ClockAlarmStatus,
  type ClockHost,
  type ClockProposal,
  type ClockStatus,
  getClockHost,
  subscribeClockHost,
} from "../../bridge/clock-host";
import { useSharedNow } from "../../hooks/useSharedNow";
import { FramedPage, FramedPageBody } from "../../layouts/framed-page";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const CLOCK_TIME_FOCUS_CSS = `#clock-alarm-time::selection {background-color:var(--accent-action);color:var(--brand-black);}`;
function repeatLabel(days: readonly number[]): string {
  return days.length === 0
    ? "Once"
    : days.length === 7
      ? "Every day"
      : days.join(",") === "2,3,4,5,6"
        ? "Weekdays"
        : days.map((day) => DAY_NAMES[day - 1].slice(0, 3)).join(", ");
}
function OwnedAlarms({ host }: { host: ClockHost }) {
  const [status, setStatus] = useState<ClockAlarmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    owner: string;
    text: string;
    unsuccessful: boolean;
  } | null>(null);
  const [editing, setEditing] = useState<ClockAlarmRecord | null>(null);
  const [time, setTime] = useState("09:00");
  const [label, setLabel] = useState("");
  const [repeat, setRepeat] = useState("once");
  const [days, setDays] = useState<ClockAlarmRecord["days"]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const reads = useRef(0);
  const owner = useRef<{ host: ClockHost; value: string | null }>({
    host,
    value: null,
  });
  const reload = useRef<(() => Promise<void>) | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    let live = true;
    ++reads.current;
    owner.current = { host, value: null };
    setStatus(null);
    setEditing(null);
    setReceipt(null);
    setBusy(null);
    setError(null);
    setActionError(null);
    inFlight.current = false;
    const load = async () => {
      if (!live || document.hidden || !host.alarmStatus) return;
      const read = ++reads.current;
      setStatus(null);
      try {
        const next = await host.alarmStatus();
        if (!live || read !== reads.current) return;
        if (owner.current.value !== next.owner) {
          setEditing(null);
          setEditorOpen(false);
          setReceipt(null);
          setTime("09:00");
          setLabel("");
          setRepeat("once");
          setDays([]);
          setActionError(null);
        }
        owner.current = { host, value: next.owner };
        setStatus(next);
        setError(null);
      } catch (failure) {
        // error-policy:J4 A rejected inventory is never represented as no saved alarms.
        if (!live || read !== reads.current) return;
        setStatus(null);
        setError(
          failure instanceof Error
            ? failure.message
            : "The phone's alarm list could not be read",
        );
      }
    };
    reload.current = load;
    void load();
    const unsubscribe = host.subscribe(() => {
      void load();
    });
    const resume = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      live = false;
      ++reads.current;
      owner.current = { host, value: null };
      if (reload.current === load) reload.current = null;
      unsubscribe();
      document.removeEventListener("visibilitychange", resume);
    };
  }, [host]);
  const manage = async (operation: ClockAlarmOperation, name: string) => {
    if (
      !host.manageAlarm ||
      !status?.available ||
      status.owner === null ||
      status.alarmsRevision === null ||
      inFlight.current
    )
      return;
    const expected = status.owner;
    const revision = status.alarmsRevision;
    inFlight.current = true;
    setBusy(name);
    setError(null);
    setActionError(null);
    setReceipt(null);
    try {
      const applied = await host.manageAlarm(operation, revision, expected);
      if (owner.current.host !== host || owner.current.value !== expected)
        return;
      const result = applied.result;
      const successful = ![
        "unavailable",
        "denied",
        "failed",
        "unknown",
      ].includes(result.status);
      setReceipt({
        owner: expected,
        unsuccessful: !successful,
        text: successful
          ? `Alarm ${result.status}${result.nextAt ? `. Next: ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: status.timeZone }).format(result.nextAt)}` : ""}.`
          : result.status === "denied"
            ? "Alarm change cancelled. Your saved alarm was not changed."
            : result.status === "unknown"
              ? "The alarm change could not be confirmed. Refresh the list before trying again."
              : `Alarm change ${result.status}. Check the phone's alarm permissions and refresh.`,
      });
      if (
        successful &&
        (operation.action === "set" || operation.action === "update")
      ) {
        setEditing(null);
        setLabel("");
        setEditorOpen(false);
      }
      if (successful && operation.action === "delete") setEditorOpen(false);
      await reload.current?.();
    } catch (failure) {
      // error-policy:J1 A failed change is reported without retrying or inferring a saved alarm.
      if (owner.current.host === host && owner.current.value === expected) {
        setActionError(
          failure instanceof Error
            ? failure.message
            : "The alarm change could not be confirmed",
        );
        await reload.current?.();
      }
    } finally {
      if (owner.current.host === host) {
        inFlight.current = false;
        setBusy(null);
      }
    }
  };
  const permission = async (
    value: "exact" | "notifications" | "fullScreen",
  ) => {
    if (!host.requestAlarmPermission || inFlight.current) return;
    inFlight.current = true;
    setBusy(value);
    try {
      await host.requestAlarmPermission(value);
      await reload.current?.();
    } catch (failure) {
      if (owner.current.host === host)
        setError(
          failure instanceof Error
            ? failure.message
            : "Android permission settings could not be opened",
        );
    } finally {
      if (owner.current.host === host) {
        inFlight.current = false;
        setBusy(null);
      }
    }
  };
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const labelValid =
    label.length <= 200 &&
    [...label].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    );
  const repeatDays: ClockAlarmRecord["days"] =
    repeat === "daily"
      ? [1, 2, 3, 4, 5, 6, 7]
      : repeat === "weekdays"
        ? [2, 3, 4, 5, 6]
        : repeat === "custom"
          ? days
          : [];
  const validForm =
    valid && labelValid && (repeat !== "custom" || days.length > 0);
  const canSchedule =
    !!host.manageAlarm &&
    !!status?.available &&
    status.exactAlarmsAllowed &&
    status.notificationsAllowed &&
    status.defaultToneAvailable;
  const canSave =
    !!host.manageAlarm &&
    !!status?.available &&
    (status.alarms?.some(
      (alarm) => alarm.id === editing?.id && !alarm.enabled,
    ) ||
      canSchedule);
  const submit = () => {
    if (!validForm || !canSave || busy || !status) return;
    const [hour, minute] = time.split(":").map(Number);
    const fields = {
      hour,
      minute,
      label,
      timeZone: status.timeZone,
      days: repeatDays,
    };
    void manage(
      editing
        ? {
            type: "clock_alarm",
            action: "update",
            alarmId: editing.id,
            ...fields,
          }
        : { type: "clock_alarm", action: "set", ...fields },
      "save",
    );
  };
  const timeElement = useAgentElement<HTMLInputElement>({
    id: "clock-alarm-time",
    role: "text-input",
    label: "Alarm time",
    onFill: (value) => {
      setTime(value);
    },
  });
  const labelElement = useAgentElement<HTMLInputElement>({
    id: "clock-alarm-label",
    role: "text-input",
    label: "Alarm label",
    onFill: (value) => {
      setLabel(value);
    },
  });
  const saveElement = useAgentElement<HTMLButtonElement>({
    id: "clock-alarm-save",
    role: "button",
    label: editing ? "Save alarm changes" : "Create alarm",
    status: canSave && validForm && !busy ? "ready" : "disabled",
    onActivate: submit,
  });
  const repeatElement = useAgentElement<HTMLSelectElement>({
    id: "clock-alarm-repeat",
    role: "select",
    label: "Repeat",
    onFill: (value) => {
      if (["once", "daily", "weekdays", "custom"].includes(value)) {
        setRepeat(value);
      }
    },
  });
  // A new host must never paint the previous host's rows or draft before its effect runs.
  if (owner.current.host !== host)
    return (
      <section aria-label="Eliza alarms">
        <p role="status">Loading this phone’s alarms…</p>
      </section>
    );
  const receiptFeedback =
    receipt && receipt.owner === status?.owner ? (
      <p
        role="status"
        className={
          receipt.unsuccessful ? "text-sm text-destructive" : "sr-only"
        }
      >
        {receipt.text}
      </p>
    ) : null;
  return (
    <section aria-label="Eliza alarms" className="mx-auto max-w-xl">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-medium">Alarms</h1>
        <Button
          variant="ghost"
          aria-label="Add alarm"
          disabled={!status?.available || busy !== null}
          onClick={() => {
            setEditing(null);
            setTime("09:00");
            setLabel("");
            setRepeat("once");
            setDays([]);
            setEditorOpen(true);
          }}
        >
          <Plus className="size-6 text-accent-action" aria-hidden />
        </Button>
      </div>
      {!status && !error && (
        <p role="status" className="py-8 text-sm text-muted-foreground">
          Loading…
        </p>
      )}
      {status && !status.available && (
        <p role="status" className="text-sm text-muted-foreground">
          {status.reason}
        </p>
      )}
      {(error || actionError) && (
        <div className="mb-4 flex items-center justify-between gap-4">
          <p role="alert" className="text-sm text-destructive">
            {error || actionError}
          </p>
          <Button variant="ghost" onClick={() => void reload.current?.()}>
            Retry
          </Button>
        </div>
      )}
      {!editorOpen && receiptFeedback}
      {status?.available && (
        <>
          {(!status.exactAlarmsAllowed ||
            !status.notificationsAllowed ||
            !status.defaultToneAvailable) && (
            <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
              {!status.exactAlarmsAllowed && (
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void permission("exact")}
                >
                  Allow alarms
                </Button>
              )}
              {!status.notificationsAllowed && (
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void permission("notifications")}
                >
                  Allow notifications
                </Button>
              )}
              {!status.defaultToneAvailable && (
                <p role="alert">Choose an alarm sound in Android settings.</p>
              )}
            </div>
          )}
          {status.alarmSoundMuted && (
            <p role="status" className="mb-4 text-sm text-muted-foreground">
              Alarm volume is muted.
            </p>
          )}
          {status.alarms?.length === 0 && (
            <p className="py-12 text-center text-muted-foreground">No alarms</p>
          )}
          <ul className="divide-y divide-border">
            {status.alarms?.map((alarm) => (
              <li
                key={alarm.id}
                aria-label={alarm.label || "Alarm"}
                className="py-6"
              >
                <div className="flex items-center justify-between gap-6">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-action"
                    aria-label={`Edit ${alarm.label || "alarm"}`}
                    disabled={busy !== null}
                    onClick={() => {
                      setEditing(alarm);
                      setTime(
                        `${String(alarm.hour).padStart(2, "0")}:${String(alarm.minute).padStart(2, "0")}`,
                      );
                      setLabel(alarm.label);
                      setDays(alarm.days);
                      setRepeat(
                        alarm.days.length === 0
                          ? "once"
                          : alarm.days.length === 7
                            ? "daily"
                            : alarm.days.join(",") === "2,3,4,5,6"
                              ? "weekdays"
                              : "custom",
                      );
                      setEditorOpen(true);
                    }}
                  >
                    <span
                      className={`block text-4xl font-normal tabular-nums ${alarm.enabled || alarm.scheduleState === "firing" ? "text-txt" : "text-muted-foreground"}`}
                    >
                      {String(alarm.hour).padStart(2, "0")}:
                      {String(alarm.minute).padStart(2, "0")}
                    </span>
                    <span className="mt-2 block break-words text-sm text-muted-foreground">
                      {[alarm.label, repeatLabel(alarm.days)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                  <Switch
                    aria-label={`${alarm.enabled ? "Disable" : "Enable"} ${alarm.label || "alarm"}`}
                    checked={alarm.enabled}
                    disabled={busy !== null || (!alarm.enabled && !canSchedule)}
                    className="data-[state=checked]:bg-accent-action"
                    onCheckedChange={(enabled) =>
                      void manage(
                        {
                          type: "clock_alarm",
                          action: "enable",
                          alarmId: alarm.id,
                          enabled,
                        },
                        alarm.id,
                      )
                    }
                  />
                </div>
                {alarm.scheduleState === "firing" && (
                  <div className="mt-4 flex gap-3">
                    <Button
                      className="flex-1 bg-accent-action text-brand-black hover:bg-accent-action-hover"
                      disabled={busy !== null}
                      onClick={() =>
                        void manage(
                          {
                            type: "clock_alarm",
                            action: "dismiss",
                            alarmId: alarm.id,
                          },
                          alarm.id,
                        )
                      }
                    >
                      Stop
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      disabled={busy !== null}
                      onClick={() =>
                        void manage(
                          {
                            type: "clock_alarm",
                            action: "snooze",
                            alarmId: alarm.id,
                            minutes: 5,
                          },
                          alarm.id,
                        )
                      }
                    >
                      Snooze
                    </Button>
                  </div>
                )}
                {alarm.scheduleState === "snoozed" && alarm.nextAt && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Snoozed until{" "}
                    {new Intl.DateTimeFormat(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: status.timeZone,
                    }).format(alarm.nextAt)}
                  </p>
                )}
                {["permission_required", "schedule_unknown"].includes(
                  alarm.scheduleState,
                ) && (
                  <p role="status" className="mt-2 text-sm text-destructive">
                    {alarm.scheduleState === "permission_required"
                      ? "Alarm permission required"
                      : "Schedule could not be confirmed"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          if (!busy) setEditorOpen(open);
        }}
      >
        <DialogContent
          className="max-w-sm overflow-y-auto max-sm:bottom-[calc(max(var(--eliza-chat-clearance,0px),var(--safe-area-bottom,0px))+3rem)] max-sm:max-h-[calc(100dvh_-_max(var(--eliza-chat-clearance,0px),var(--safe-area-bottom,0px))_-_4rem)]"
          showCloseButton={false}
        >
          <DialogTitle className="text-lg font-medium">
            {editing ? "Edit alarm" : "New alarm"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Set the time, repeat days and label.
          </DialogDescription>
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label htmlFor="clock-alarm-time" className="block">
              <span className="sr-only">Alarm time</span>
              <Input
                id="clock-alarm-time"
                type="time"
                value={time}
                required
                ref={timeElement.ref}
                {...timeElement.agentProps}
                className="h-20 text-center text-4xl tabular-nums"
                onChange={(event) => setTime(event.target.value)}
              />
            </label>
            <label className="block space-y-2">
              <span className="text-sm">Repeat</span>
              <select
                id="clock-alarm-repeat"
                value={repeat}
                ref={repeatElement.ref}
                {...repeatElement.agentProps}
                className="h-11 w-full rounded-sm border border-border bg-bg px-3 text-base"
                onChange={(event) => setRepeat(event.target.value)}
              >
                <option value="once">Once</option>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="custom">Selected days</option>
              </select>
            </label>
            {repeat === "custom" && (
              <fieldset
                className="flex justify-between gap-1"
                aria-label="Repeat days"
              >
                {([1, 2, 3, 4, 5, 6, 7] as const).map((dayNumber) => (
                  <button
                    key={dayNumber}
                    type="button"
                    aria-label={DAY_NAMES[dayNumber - 1]}
                    aria-pressed={days.includes(dayNumber)}
                    className={`size-10 rounded-full text-sm ${days.includes(dayNumber) ? "bg-accent-action text-brand-black" : "bg-muted text-txt"}`}
                    onClick={() =>
                      setDays((current) =>
                        current.includes(dayNumber)
                          ? current.filter((value) => value !== dayNumber)
                          : [...current, dayNumber].sort((a, b) => a - b),
                      )
                    }
                  >
                    {DAY_NAMES[dayNumber - 1].slice(0, 1)}
                  </button>
                ))}
              </fieldset>
            )}
            <label htmlFor="clock-alarm-label" className="block space-y-2">
              <span className="text-sm">Label</span>
              <Input
                id="clock-alarm-label"
                value={label}
                maxLength={200}
                placeholder="Alarm"
                ref={labelElement.ref}
                {...labelElement.agentProps}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            {receiptFeedback}
            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
            <div className="flex justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setEditorOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!canSave || !validForm || busy !== null}
                ref={saveElement.ref}
                {...saveElement.agentProps}
                aria-label="Save"
                className="bg-accent-action text-brand-black hover:bg-accent-action-hover"
              >
                {busy === "save" ? "Saving…" : "Save"}
              </Button>
            </div>
            {editing && (
              <Button
                type="button"
                variant="ghost"
                className="w-full text-destructive"
                disabled={busy !== null}
                onClick={() =>
                  void manage(
                    {
                      type: "clock_alarm",
                      action: "delete",
                      alarmId: editing.id,
                    },
                    "delete",
                  )
                }
              >
                Delete alarm
              </Button>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
function ClockControls() {
  const now = useSharedNow();
  const host = useSyncExternalStore(
    subscribeClockHost,
    getClockHost,
    () => null,
  );
  const ownedMode = typeof host?.alarmStatus === "function";
  const [native, setNative] = useState<ClockStatus | null>(null);
  const [proposals, setProposals] = useState<ClockProposal[]>([]);
  const [scope, setScope] = useState<string | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{
    scope: string;
    text: string;
    pending: ClockProposal | null;
  } | null>(null);
  const reloadRequests = useRef<(() => Promise<void>) | null>(null);
  const readRevision = useRef(0);
  const settled = useRef<{ scope: string | null; ids: Set<string> }>({
    scope: null,
    ids: new Set(),
  });
  const activeReview = useRef<AbortController | null>(null);
  const owner = useRef<{ host: ClockHost | null; scope: string | null }>({
    host: null,
    scope: null,
  });
  useEffect(() => {
    let live = true;
    ++readRevision.current;
    settled.current = { scope: null, ids: new Set() };
    owner.current = { host, scope: null };
    setNative(null);
    setScope(null);
    setProposals([]);
    setOutcome(null);
    setNativeError(null);
    setRefreshError(null);
    setReviewing(null);
    const load = async () => {
      // Android Clock pauses this view after dispatch. Reads resume on return;
      // no paused read can invalidate an already recorded handoff.
      if (!live || !host || document.hidden) return;
      const current = ++readRevision.current;
      let verifiedStatus: ClockStatus | null = null;
      if (live) {
        setNative(null);
        setScope(null);
        setProposals([]);
      }
      try {
        const status = await host.status();
        if (!live || current !== readRevision.current) return;
        verifiedStatus = status;
        if (settled.current.scope !== status.scope)
          settled.current = { scope: status.scope, ids: new Set() };
        if (owner.current.scope !== status.scope) {
          activeReview.current?.abort();
          setReviewing(null);
          owner.current = { host, scope: status.scope };
        }
        setOutcome((recorded) =>
          recorded?.scope === status.scope ? recorded : null,
        );
        setNative(status);
        setRefreshError(null);
        if (status.supported) {
          const list = await host.proposals();
          if (live && current === readRevision.current) {
            if (list.scope !== status.scope)
              throw new Error("Clock owner changed during refresh");
            setProposals(
              list.proposals.filter(
                (entry) => !settled.current.ids.has(entry.id),
              ),
            );
            setScope(list.scope);
            setNativeError(null);
          }
        } else {
          setProposals([]);
          setScope(null);
        }
      } catch (error) {
        // error-policy:J4 failed reads remain errors, never a healthy-empty alarm inventory.
        if (live && current === readRevision.current) {
          activeReview.current?.abort();
          // A failed list read retires fresh proposals. A saved receipt remains
          // visible, but reconciliation needs a freshly verified owner.
          const owned = verifiedStatus?.supported ? verifiedStatus : null;
          owner.current = { host, scope: owned?.scope ?? null };
          setNative(owned);
          setScope(owned?.scope ?? null);
          setProposals([]);
          setReviewing(null);
          setRefreshError(
            error instanceof Error
              ? error.message
              : "Clock support could not be checked",
          );
        }
      }
    };
    reloadRequests.current = load;
    void load();
    const unsubscribe = host?.subscribe(() => {
      void load();
    });
    const resume = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      live = false;
      if (reloadRequests.current === load) reloadRequests.current = null;
      unsubscribe?.();
      document.removeEventListener("visibilitychange", resume);
      activeReview.current?.abort();
    };
  }, [host]);
  const review = async (proposal: ClockProposal) => {
    if (!host || !scope || reviewing) return;
    const reviewedOwner = owner.current;
    if (reviewedOwner.host !== host || reviewedOwner.scope !== scope) return;
    const abort = new AbortController();
    activeReview.current = abort;
    setReviewing(proposal.id);
    setOutcome((recorded) =>
      recorded?.scope === scope && recorded.pending?.id === proposal.id
        ? recorded
        : null,
    );
    setNativeError(null);
    setRefreshError(null);
    try {
      const result = await host.review(proposal, scope, abort.signal);
      if (abort.signal.aborted || owner.current !== reviewedOwner) return;
      ++readRevision.current;
      if (!result.receiptPending) {
        if (settled.current.scope !== scope)
          settled.current = { scope, ids: new Set() };
        settled.current.ids.add(proposal.id);
      }
      setOutcome({
        scope,
        pending: result.receiptPending
          ? { ...proposal, state: "reconciliation_required" }
          : null,
        text:
          result.handoff.kind === "clock-alarm"
            ? `Alarm ${result.handoff.status} on this phone.${result.receiptPending ? " Server receipt remains pending. Check the saved receipt to settle it without another alarm change." : ""} Sound follows the phone's alarm settings.`
            : result.receiptPending
              ? `Clock result: ${result.handoff.status}; server receipt remains pending. Check the saved receipt again to retry settlement without another dispatch. No installed or ringing alarm is confirmed.`
              : result.handoff.status === "opened"
                ? "Android Clock opened. Check the installed alarm there; ringing is not confirmed."
                : `Clock result: ${result.handoff.status}. No installed or ringing alarm is confirmed.`,
      });
      // Keep a lost acknowledgement reachable without re-offering dispatch.
      // Settled requests leave the actionable list until a foreground refresh.
      setProposals((current) =>
        result.receiptPending
          ? current.map((entry) =>
              entry.id === proposal.id
                ? { ...entry, state: "reconciliation_required" }
                : entry,
            )
          : current.filter((entry) => entry.id !== proposal.id),
      );
    } catch (error) {
      // error-policy:J1 the review boundary reports failure without replaying the native effect.
      if (!abort.signal.aborted && owner.current === reviewedOwner)
        setNativeError(
          error instanceof Error ? error.message : "Clock review failed",
        );
    } finally {
      if (activeReview.current === abort) activeReview.current = null;
      if (!abort.signal.aborted && owner.current === reviewedOwner)
        setReviewing(null);
    }
  };
  const reviewable = proposals.filter((p) =>
    ["pending", "approved", "executing", "reconciliation_required"].includes(
      p.state,
    ),
  );
  if (outcome?.pending && !reviewable.some((p) => p.id === outcome.pending?.id))
    reviewable.push(outcome.pending);
  return (
    <FramedPage
      gutterOwner="framed-page"
      data-testid="clock-layout"
      data-chat-clearance-aware="true"
    >
      <style>{CLOCK_TIME_FOCUS_CSS}</style>
      <FramedPageBody className="space-y-6">
        {ownedMode && host ? (
          <OwnedAlarms host={host} />
        ) : (
          <div className="mx-auto max-w-xl">
            <h1 className="mb-8 text-2xl font-medium">Alarms</h1>
            <p className="text-sm text-muted-foreground">
              Open Clock on your Android phone to manage alarms.
            </p>
          </div>
        )}
        {nativeError && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {nativeError}
            </p>
            {host && (
              <Button
                variant="outline"
                onClick={() => {
                  void reloadRequests.current?.();
                }}
              >
                {ownedMode ? "Retry agent requests" : "Retry Clock support"}
              </Button>
            )}
          </div>
        )}
        {refreshError && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {ownedMode
                ? "Agent alarm requests could not be refreshed."
                : "Clock requests could not be refreshed."}{" "}
              {refreshError}
            </p>
            {host && (
              <Button
                variant="outline"
                onClick={() => {
                  void reloadRequests.current?.();
                }}
              >
                {ownedMode
                  ? "Refresh agent requests"
                  : "Refresh Clock requests"}
              </Button>
            )}
          </div>
        )}
        {outcome && (
          <p role="status" className="text-sm">
            {outcome.text}
          </p>
        )}
        {(reviewable.length > 0 || outcome) && (
          <section aria-label="Clock proposals" className="max-w-lg space-y-3">
            <h2 className="text-base font-medium">Clock requests</h2>
            {!refreshError && host && (
              <Button
                variant="outline"
                disabled={reviewing !== null}
                onClick={() => {
                  void reloadRequests.current?.();
                }}
              >
                {ownedMode
                  ? "Refresh agent requests"
                  : "Refresh Clock requests"}
              </Button>
            )}
            {reviewable.map((proposal) => {
              const freshReview = ["pending", "approved"].includes(
                proposal.state,
              );
              // `useSharedNow` is 0 until the store ticks. `now || Date.now()`
              // reads the wall clock during that render and enables Review.
              const clockReady = now > 0;
              const deadlineMs = Date.parse(proposal.expiresAt);
              const expired =
                freshReview &&
                clockReady &&
                Number.isFinite(deadlineMs) &&
                deadlineMs <= now;
              const supported = clockCapabilityAvailable(
                proposal.operation,
                native?.capabilities,
              );
              return (
                <div key={proposal.id} className="border-b border-border py-3">
                  <p className="text-sm">
                    {proposal.operation.action === "set"
                      ? `${String(proposal.operation.hour).padStart(2, "0")}:${String(proposal.operation.minute).padStart(2, "0")} ${proposal.operation.label} — ${proposal.operation.days?.length ? proposal.operation.days.map((day) => DAY_NAMES[day - 1]).join(", ") : "Once"}`
                      : proposal.operation.action}
                  </p>
                  {expired && (
                    <p className="text-sm text-muted-foreground">
                      Request expired. Send a new request in chat.
                    </p>
                  )}
                  {!supported && (
                    <p className="text-sm text-muted-foreground">
                      {native?.supported
                        ? "This request requires newer Clock support on this phone."
                        : "Refresh Clock support before checking this saved receipt."}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    disabled={
                      reviewing !== null ||
                      !clockReady ||
                      expired ||
                      !supported ||
                      scope === null
                    }
                    onClick={() => {
                      void review(proposal);
                    }}
                  >
                    {reviewing === proposal.id
                      ? freshReview
                        ? "Waiting for phone approval…"
                        : "Checking saved receipt…"
                      : freshReview
                        ? "Review on this phone"
                        : "Check saved receipt"}
                  </Button>
                </div>
              );
            })}
          </section>
        )}
      </FramedPageBody>
    </FramedPage>
  );
}
export function ClockView() {
  return (
    <ShellViewAgentSurface viewId="clock">
      <ClockControls />
    </ShellViewAgentSurface>
  );
}
