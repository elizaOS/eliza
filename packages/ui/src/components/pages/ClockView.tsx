/**
 * Clock displays local time and prepares alarm requests in the existing chat
 * composer. Android's Clock app owns alarms; a draft never schedules one or
 * establishes its installed state. The device proposal path owns approval.
 */
import { AlarmClock, ArrowRight } from "lucide-react";
import { useState } from "react";
import { useAgentElement } from "../../agent-surface/useAgentElement";
import { navigateBrowserPath } from "../../app-navigate-view";
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

const CLOCK_TIME_FOCUS_CSS = `
#clock-alarm-time::selection {
  background-color: var(--accent-action);
  color: var(--brand-black);
}
`;

function ClockControls() {
  const now = useSharedNow();
  const [time, setTime] = useState("");
  const [label, setLabel] = useState("");
  const [drafted, setDrafted] = useState(false);
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const labelValid =
    label.length <= 200 &&
    [...label].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    });
  const prepare = () => {
    if (!valid || !labelValid) return;
    // Cost: one local composer event per gesture; no model, HTTP or native effect.
    dispatchChatPrefill({
      text: `Propose an Android Clock alarm for ${time} in my phone's current timezone${label ? ` with label ${JSON.stringify(label)}` : ""}. Ask me to review it before dispatch.`,
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
    status: valid && labelValid ? "ready" : "disabled",
    onActivate: prepare,
  });
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
              <AlarmClock className="size-5" aria-hidden /> Android alarm
            </h2>
            <p className="text-sm text-muted-foreground">
              Prepare a request for a compatible Android phone. Send it in chat,
              then review the proposal before any native handoff.
            </p>
            <p className="text-sm font-medium">
              Alarm delivery is unavailable here. Preparing a request does not
              install an alarm.
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
              disabled={!valid || !labelValid}
              ref={requestElement.ref}
              {...requestElement.agentProps}
            >
              Prepare alarm request{" "}
              <ArrowRight className="ml-2 size-4" aria-hidden />
            </Button>
            {drafted && (
              <p role="status" className="text-sm">
                Request ready in chat. No alarm has been installed.
              </p>
            )}
          </form>
        </section>
        <section
          aria-labelledby="clock-alarm-status"
          className="max-w-lg space-y-3 border-t border-border pt-6"
        >
          <h2 id="clock-alarm-status" className="text-base font-medium">
            Check alarms on your phone
          </h2>
          <p className="text-sm text-muted-foreground">
            Android Clock owns the alarm list and ringing. Opening Clock
            confirms the handoff only. Check the time, enabled state and sound
            there.
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
