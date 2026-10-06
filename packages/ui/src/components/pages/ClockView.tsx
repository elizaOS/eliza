/** Clock prepares exact native alarm requests and exposes the host's owned proposal review. Android Clock owns delivery; dispatch never establishes installation or ringing. */
import { clockCapabilityAvailable } from "@elizaos/plugin-assistant/device-clock-review";
import { AlarmClock, ArrowRight } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAgentElement } from "../../agent-surface/useAgentElement";
import { navigateBrowserPath } from "../../app-navigate-view";
import {
  type ClockHost,
  type ClockProposal,
  type ClockStatus,
  getClockHost,
  subscribeClockHost,
} from "../../bridge/clock-host";
import { dispatchChatPrefill } from "../../events";
import { useSharedNow } from "../../hooks/useSharedNow";
import {
  FramedPage,
  FramedPageBody,
  FramedPageHeader,
} from "../../layouts/framed-page";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
function ClockControls() {
  const now = useSharedNow();
  const host = useSyncExternalStore(
    subscribeClockHost,
    getClockHost,
    () => null,
  );
  const [native, setNative] = useState<ClockStatus | null>(null);
  const [proposals, setProposals] = useState<ClockProposal[]>([]);
  const [scope, setScope] = useState<string | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const activeReview = useRef<AbortController | null>(null);
  const owner = useRef<{ host: ClockHost | null; scope: string | null }>({
    host: null,
    scope: null,
  });
  useEffect(() => {
    let live = true;
    let revision = refresh;
    owner.current = { host, scope: null };
    setNative(null);
    setScope(null);
    setProposals([]);
    setOutcome(null);
    setNativeError(null);
    setReviewing(null);
    const load = async () => {
      const current = ++revision;
      if (!host) return;
      if (live) {
        setNative(null);
        setScope(null);
        setProposals([]);
      }
      try {
        const status = await host.status();
        if (!live || current !== revision) return;
        if (owner.current.scope !== status.scope) {
          activeReview.current?.abort();
          setReviewing(null);
          setOutcome(null);
          owner.current = { host, scope: status.scope };
        }
        setNative(status);
        setNativeError(null);
        if (status.supported) {
          const list = await host.proposals();
          if (live && current === revision) {
            if (list.scope !== status.scope)
              throw new Error("Clock owner changed during refresh");
            setProposals(list.proposals);
            setScope(list.scope);
          }
        } else {
          setProposals([]);
          setScope(null);
        }
      } catch (error) {
        // error-policy:J4 failed reads remain errors, never a healthy-empty alarm inventory.
        if (live && current === revision) {
          activeReview.current?.abort();
          owner.current = { host, scope: null };
          setNative(null);
          setScope(null);
          setProposals([]);
          setOutcome(null);
          setReviewing(null);
          setNativeError(
            error instanceof Error
              ? error.message
              : "Clock support could not be checked",
          );
        }
      }
    };
    void load();
    const unsubscribe = host?.subscribe(() => {
      void load();
    });
    return () => {
      live = false;
      unsubscribe?.();
      activeReview.current?.abort();
    };
  }, [host, refresh]);
  const review = async (proposal: ClockProposal) => {
    if (!host || !scope || reviewing) return;
    const reviewedOwner = owner.current;
    if (reviewedOwner.host !== host || reviewedOwner.scope !== scope) return;
    const abort = new AbortController();
    activeReview.current = abort;
    setReviewing(proposal.id);
    setOutcome(null);
    setNativeError(null);
    try {
      const result = await host.review(proposal, scope, abort.signal);
      if (abort.signal.aborted || owner.current !== reviewedOwner) return;
      setOutcome(
        result.receiptPending
          ? `Clock result: ${result.handoff.status}; server receipt remains pending. Check the saved receipt again to retry settlement without another dispatch. No installed or ringing alarm is confirmed.`
          : result.handoff.status === "opened"
            ? "Android Clock opened. Check the installed alarm there; ringing is not confirmed."
            : `Clock result: ${result.handoff.status}. No installed or ringing alarm is confirmed.`,
      );
      const list = await host.proposals();
      if (!abort.signal.aborted && owner.current === reviewedOwner) {
        if (list.scope !== scope) {
          setOutcome(null);
          setNative(null);
          setScope(null);
          setProposals([]);
          throw new Error("Clock owner changed during receipt refresh");
        }
        setProposals(list.proposals);
        setScope(list.scope);
      }
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
  const [time, setTime] = useState("");
  const [label, setLabel] = useState("");
  const [repeat, setRepeat] = useState("once");
  const [days, setDays] = useState<number[]>([]);
  const [drafted, setDrafted] = useState(false);
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const labelValid =
    label.length <= 200 &&
    [...label].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    });
  const repeatValid = repeat !== "custom" || days.length > 0;
  const prepare = () => {
    if (!valid || !labelValid || !repeatValid) return;
    // Cost: one local composer event, no automatic model request or native effect.
    dispatchChatPrefill({
      text: `Propose an Android Clock alarm for ${time} ${repeat === "daily" ? "every day" : repeat === "weekdays" ? "every weekday (Monday through Friday)" : repeat === "custom" ? `every ${days.map((day) => DAY_NAMES[day - 1]).join(", ")}` : "once"} in my phone's current timezone${label ? ` with label ${JSON.stringify(label)}` : ""}. Preserve the repeat days and ask me to review before dispatch.`,
    });
    setDrafted(true);
  };
  const timeElement = useAgentElement<HTMLInputElement>({
    id: "clock-alarm-time",
    role: "text-input",
    label: "Alarm time",
    onFill: (value) => {
      setTime(value);
      setDrafted(false);
    },
  });
  const labelElement = useAgentElement<HTMLInputElement>({
    id: "clock-alarm-label",
    role: "text-input",
    label: "Alarm label",
    onFill: (value) => {
      setLabel(value);
      setDrafted(false);
    },
  });
  const requestElement = useAgentElement<HTMLButtonElement>({
    id: "clock-alarm-request",
    role: "button",
    label: "Prepare alarm request",
    status: valid && labelValid && repeatValid ? "ready" : "disabled",
    onActivate: prepare,
  });
  const repeatElement = useAgentElement<HTMLSelectElement>({
    id: "clock-alarm-repeat",
    role: "select",
    label: "Repeat",
    onFill: (value) => {
      if (["once", "daily", "weekdays", "custom"].includes(value)) {
        setRepeat(value);
        setDrafted(false);
      }
    },
  });
  const reviewable = proposals.filter((p) =>
    [
      "pending",
      "approved",
      "executing",
      "done",
      "reconciliation_required",
    ].includes(p.state),
  );
  return (
    <FramedPage
      gutterOwner="framed-page"
      data-testid="clock-layout"
      data-chat-clearance-aware="true"
    >
      <style>{CLOCK_TIME_FOCUS_CSS}</style>
      <FramedPageHeader
        actions={
          <Button
            variant="outline"
            onClick={() => navigateBrowserPath("/automations")}
          >
            Manage reminders
          </Button>
        }
      />
      <FramedPageBody className="space-y-8">
        <h1 className="text-xl font-medium">Clock</h1>
        <section
          aria-label="Local time"
          className="space-y-2 border-b border-border pb-6"
        >
          <p className="text-sm text-muted-foreground">Time on this device</p>
          <p className="text-4xl font-medium tabular-nums">
            {now === 0
              ? "—"
              : new Intl.DateTimeFormat(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                }).format(now)}
          </p>
          <p className="text-sm text-muted-foreground">
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </p>
        </section>
        <section
          aria-labelledby="clock-alarm-heading"
          className="max-w-lg space-y-5"
        >
          <div className="space-y-2">
            <h2
              id="clock-alarm-heading"
              className="flex items-center gap-2 text-lg font-medium"
            >
              <AlarmClock className="size-5" aria-hidden />
              Android alarm
            </h2>
            <p className="text-sm text-muted-foreground">
              Prepare a request for a compatible Android phone. Send it in chat,
              then review the proposal before any native handoff.
            </p>
            <p className="text-sm font-medium">
              {native?.supported
                ? "Native Clock requests are available. Every request needs approval on this phone."
                : host && !native && !nativeError
                  ? "Checking native Clock support…"
                  : nativeError
                    ? "Clock support could not be checked."
                    : `Alarm delivery is unavailable here${native?.reason ? `: ${native.reason}` : "."} Preparing a request does not install an alarm.`}
            </p>
          </div>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              prepare();
            }}
          >
            <div className="space-y-2">
              <label htmlFor="clock-alarm-time" className="text-sm font-medium">
                Alarm time
              </label>
              <Input
                id="clock-alarm-time"
                type="text"
                placeholder="HH:MM"
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                aria-describedby="clock-alarm-time-hint"
                required
                value={time}
                ref={timeElement.ref}
                {...timeElement.agentProps}
                onChange={(event) => {
                  setTime(event.target.value);
                  setDrafted(false);
                }}
              />
              <p
                id="clock-alarm-time-hint"
                className="text-sm text-muted-foreground"
              >
                24-hour time (HH:MM). Uses the phone’s current timezone after it
                is checked.
              </p>
            </div>
            <div className="space-y-2">
              <label
                htmlFor="clock-alarm-repeat"
                className="text-sm font-medium"
              >
                Repeat
              </label>
              <select
                id="clock-alarm-repeat"
                value={repeat}
                ref={repeatElement.ref}
                {...repeatElement.agentProps}
                className="h-11 w-full rounded-sm border border-border bg-bg px-3 text-sm"
                onChange={(event) => {
                  setRepeat(event.target.value);
                  setDrafted(false);
                }}
              >
                <option value="once">Once</option>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays (Monday–Friday)</option>
                <option value="custom">Selected days</option>
              </select>
              {repeat === "custom" && (
                <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
                  <legend className="sr-only">Repeat days</legend>
                  {DAY_NAMES.map((name, index) => (
                    <label
                      key={name}
                      className="flex min-h-11 items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="accent-[var(--accent-action)]"
                        checked={days.includes(index + 1)}
                        onChange={(event) => {
                          setDays((previous) =>
                            event.target.checked
                              ? [...previous, index + 1].sort((a, b) => a - b)
                              : previous.filter((day) => day !== index + 1),
                          );
                          setDrafted(false);
                        }}
                      />
                      {name}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
            <div className="space-y-2">
              <label
                htmlFor="clock-alarm-label"
                className="text-sm font-medium"
              >
                Alarm label{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </label>
              <Input
                id="clock-alarm-label"
                maxLength={200}
                value={label}
                ref={labelElement.ref}
                {...labelElement.agentProps}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setDrafted(false);
                }}
              />
            </div>
            <Button
              type="submit"
              variant="selection"
              disabled={!valid || !labelValid || !repeatValid}
              ref={requestElement.ref}
              {...requestElement.agentProps}
            >
              Prepare alarm request
              <ArrowRight className="ml-2 size-4" aria-hidden />
            </Button>
            {drafted && (
              <p role="status" className="text-sm">
                Request ready in chat. No alarm has been installed.
              </p>
            )}
          </form>
        </section>
        {nativeError && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {nativeError}
            </p>
            {host && (
              <Button
                variant="outline"
                onClick={() => setRefresh((value) => value + 1)}
              >
                Retry Clock support
              </Button>
            )}
          </div>
        )}
        {outcome && (
          <p role="status" className="text-sm">
            {outcome}
          </p>
        )}
        {native?.supported && (
          <section aria-label="Clock proposals" className="max-w-lg space-y-3">
            <h2 className="text-base font-medium">Clock requests</h2>
            {reviewable.map((proposal) => {
              const freshReview = ["pending", "approved"].includes(
                proposal.state,
              );
              const expired =
                freshReview &&
                Date.parse(proposal.expiresAt) <= (now || Date.now());
              const supported = clockCapabilityAvailable(
                proposal.operation,
                native.capabilities,
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
                      This request requires newer Clock support on this phone.
                    </p>
                  )}
                  <Button
                    variant="outline"
                    disabled={reviewing !== null || expired || !supported}
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
            {reviewable.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No pending Clock requests. Send your request in chat to create
                one.
              </p>
            )}
          </section>
        )}
        <section
          aria-labelledby="clock-alarm-status"
          className="max-w-lg space-y-3 border-t border-border pt-6"
        >
          <h2 id="clock-alarm-status" className="text-base font-medium">
            Check alarms on your phone
          </h2>
          <p className="text-sm text-muted-foreground">
            Android Clock owns the alarm list and ringing. Opening Clock
            confirms the handoff only. Check the repeat days, time, enabled
            state and sound there.
          </p>
          <p className="text-sm text-muted-foreground">
            Eliza reminders use the runtime and push notifications. They are
            managed separately.
          </p>
        </section>
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
